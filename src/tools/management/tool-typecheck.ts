import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
import { defineService } from "../../define";
import { RigConfigStoreClass, type ConfigOptions } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { RigErrorClass } from "../../errors/RigError";
import { ToolDiscoveryServiceClass } from "../../registry/discover";
import { ToolLoaderClass } from "../loader";

export type ToolTypecheckResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  checked: string[];
  tsconfigPath: string;
};

type ToolTypecheckConfigStore = Pick<RigConfigStoreClass, "ensure">;
type ToolTypecheckDiscovery = Pick<ToolDiscoveryServiceClass, "discover">;
type ToolTypecheckLoader = Pick<ToolLoaderClass, "validateToolName">;
type ToolTypecheckPaths = Pick<
  RigPathsClass,
  "runtimeDir" | "runtimeGlobalsPath" | "runtimeToolTsconfigPath" | "runtimeTypesPath"
>;

type ToolTypecheckServiceDeps = {
  createConfigStore: (options: ConfigOptions) => ToolTypecheckConfigStore;
  createDiscovery: (options: ConfigOptions) => ToolTypecheckDiscovery;
  createLoader: (options: ConfigOptions) => ToolTypecheckLoader;
  createPaths: (options: ConfigOptions) => ToolTypecheckPaths;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  dirname: typeof dirname;
  join: typeof join;
  resolvePackage: (specifier: string) => string;
  typescript: typeof ts;
  cwd: () => string;
};

const requireFromModule = createRequire(import.meta.url);

const ToolTypecheckServiceProductionDeps: ToolTypecheckServiceDeps = {
  createConfigStore(options) {
    return new RigConfigStoreClass(options);
  },
  createDiscovery(options) {
    return new ToolDiscoveryServiceClass(options);
  },
  createLoader(options) {
    return new ToolLoaderClass(options);
  },
  createPaths(options) {
    return new RigPathsClass(options);
  },
  mkdir,
  writeFile,
  dirname,
  join,
  resolvePackage(specifier) {
    return requireFromModule.resolve(specifier);
  },
  typescript: ts,
  cwd: process.cwd.bind(process),
};

export class ToolTypecheckService extends defineService({
  params: {} as ConfigOptions,
  deps: ToolTypecheckServiceProductionDeps,
}) {
  private get configStore() {
    return this.deps.createConfigStore(this.params);
  }
  private get discovery() {
    return this.deps.createDiscovery(this.params);
  }
  private get loader() {
    return this.deps.createLoader(this.params);
  }
  private get paths() {
    return this.deps.createPaths(this.params);
  }

  private formatHost(_params: {}): ts.FormatDiagnosticsHost {
    return {
      getCanonicalFileName(fileName) {
        return fileName;
      },
      getCurrentDirectory: () => this.deps.cwd(),
      getNewLine() {
        return "\n";
      },
    };
  }

  public parseHost(_params: {}): ts.ParseConfigFileHost {
    return {
      ...this.deps.typescript.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new RigErrorClass("TYPECHECK_ERROR", "Unable to parse generated Rig tool tsconfig.", {
          diagnostic: this.deps.typescript.formatDiagnostic(diagnostic, this.formatHost({})),
        });
      },
    };
  }

  private packagePath(params: { packageName: string }): string {
    return this.deps.dirname(this.deps.resolvePackage(`${params.packageName}/package.json`));
  }

  private tsconfig(params: { toolPaths: string[] }) {
    const bunTypesRoot = this.deps.dirname(this.packagePath({ packageName: "@types/bun" }));
    const zodRoot = this.packagePath({ packageName: "zod" });
    return {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        lib: ["ES2023", "DOM"],
        jsx: "preserve",
        types: ["bun"],
        typeRoots: [bunTypesRoot],
        paths: {
          zod: [this.deps.join(zodRoot, "index.d.ts")],
        },
      },
      files: [this.paths.runtimeGlobalsPath, this.paths.runtimeTypesPath, ...params.toolPaths],
    };
  }

  public runTypeScript(params: { tsconfigPath: string }): {
    stdout: string;
    exitCode: number;
  } {
    const host = this.parseHost({});
    const parsedConfig = this.deps.typescript.getParsedCommandLineOfConfigFile(
      params.tsconfigPath,
      {},
      host,
    );
    /* v8 ignore next */
    if (!parsedConfig) {
      return {
        stdout: "Unable to parse generated Rig tool tsconfig.\n",
        exitCode: 2,
      };
    }

    const program = this.deps.typescript.createProgram(
      parsedConfig.fileNames,
      parsedConfig.options,
    );
    const diagnostics = [
      ...parsedConfig.errors,
      ...this.deps.typescript.getPreEmitDiagnostics(program),
    ];
    if (diagnostics.length === 0) return { stdout: "", exitCode: 0 };
    return {
      stdout: this.deps.typescript.formatDiagnostics(diagnostics, this.formatHost({})),
      exitCode: 2,
    };
  }

  public async typecheck(params: { toolName?: string }): Promise<ToolTypecheckResult> {
    await this.configStore.ensure();
    const discovered = await this.discovery.discover();
    const selected = params.toolName
      ? discovered.filter(function selectTool(tool) {
          return tool.name === params.toolName;
        })
      : discovered;

    if (params.toolName) {
      this.loader.validateToolName(params.toolName);
      if (selected.length === 0) {
        throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${params.toolName}`, {
          available: discovered.map(function toolName(tool) {
            return tool.name;
          }),
        });
      }
    }

    await this.deps.mkdir(this.paths.runtimeDir, { recursive: true });
    const checked = selected.map(function toolPath(tool) {
      return tool.toolPath;
    });
    await this.deps.writeFile(
      this.paths.runtimeToolTsconfigPath,
      JSON.stringify(this.tsconfig({ toolPaths: checked }), null, 2),
      "utf8",
    );

    const result = this.runTypeScript({ tsconfigPath: this.paths.runtimeToolTsconfigPath });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: "",
      checked,
      tsconfigPath: this.paths.runtimeToolTsconfigPath,
    };
  }
}

export const ToolTypecheck = new ToolTypecheckService();

export type ToolTypecheckServiceClass = {
  typecheck(toolName?: string): Promise<ToolTypecheckResult>;
};

type ToolTypecheckServiceConstructor = {
  new (options?: ConfigOptions): ToolTypecheckServiceClass;
  readonly prototype: ToolTypecheckServiceClass;
};

type ToolTypecheckServiceAdapter = ToolTypecheckServiceClass & {
  readonly resource: ToolTypecheckService;
  runTypeScript(tsconfigPath: string): { stdout: string; exitCode: number };
  parseHost(): ts.ParseConfigFileHost;
};

const ToolTypecheckServiceClassAdapter = function constructToolTypecheckService(
  this: ToolTypecheckServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolTypecheckService({
      params: options,
      deps: ToolTypecheckServiceProductionDeps,
    }),
  });
};
Object.defineProperty(ToolTypecheckServiceClassAdapter, "name", {
  value: "ToolTypecheckServiceClass",
});
Object.defineProperties(ToolTypecheckServiceClassAdapter.prototype, {
  typecheck: {
    configurable: true,
    value: function typecheck(this: ToolTypecheckServiceAdapter, toolName?: string) {
      return this.resource.typecheck({ toolName });
    },
    writable: true,
  },
  runTypeScript: {
    configurable: true,
    value: function runTypeScript(this: ToolTypecheckServiceAdapter, tsconfigPath: string) {
      return this.resource.runTypeScript({ tsconfigPath });
    },
    writable: true,
  },
  parseHost: {
    configurable: true,
    value: function parseHost(this: ToolTypecheckServiceAdapter) {
      return this.resource.parseHost({});
    },
    writable: true,
  },
});

export const ToolTypecheckServiceClass =
  ToolTypecheckServiceClassAdapter as unknown as ToolTypecheckServiceConstructor;
