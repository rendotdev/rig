import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
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

export class ToolTypecheckServiceClass {
  private readonly configStore: RigConfigStoreClass;
  private readonly discovery: ToolDiscoveryServiceClass;
  private readonly loader: ToolLoaderClass;
  private readonly paths: RigPathsClass;
  private readonly require = createRequire(import.meta.url);

  constructor(private readonly options: ConfigOptions = {}) {
    this.configStore = new RigConfigStoreClass(options);
    this.discovery = new ToolDiscoveryServiceClass(options);
    this.loader = new ToolLoaderClass(options);
    this.paths = new RigPathsClass(options);
  }

  async typecheck(toolName?: string): Promise<ToolTypecheckResult> {
    await this.configStore.ensure();
    const discovered = await this.discovery.discover();
    const selected = toolName ? discovered.filter((tool) => tool.name === toolName) : discovered;

    if (toolName) {
      this.loader.validateToolName(toolName);
      if (selected.length === 0) {
        throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${toolName}`, {
          available: discovered.map((tool) => tool.name),
        });
      }
    }

    await mkdir(this.paths.runtimeDir, { recursive: true });
    const checked = selected.map((tool) => tool.toolPath);
    await writeFile(
      this.paths.runtimeToolTsconfigPath,
      JSON.stringify(this.tsconfig(checked), null, 2),
      "utf8",
    );

    const result = this.runTypeScript(this.paths.runtimeToolTsconfigPath);
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: "",
      checked,
      tsconfigPath: this.paths.runtimeToolTsconfigPath,
    };
  }

  private tsconfig(toolPaths: string[]) {
    const bunTypesRoot = dirname(this.packagePath("@types/bun"));
    const zodRoot = this.packagePath("zod");
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
          zod: [join(zodRoot, "index.d.ts")],
        },
      },
      files: [this.paths.runtimeGlobalsPath, this.paths.runtimeTypesPath, ...toolPaths],
    };
  }

  private runTypeScript(tsconfigPath: string): { stdout: string; exitCode: number } {
    const host = this.parseHost();
    const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);
    /* v8 ignore next */
    if (!config) {
      return {
        stdout: "Unable to parse generated Rig tool tsconfig.\n",
        exitCode: 2,
      };
    }

    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
    if (diagnostics.length === 0) return { stdout: "", exitCode: 0 };
    return {
      stdout: ts.formatDiagnostics(diagnostics, this.formatHost()),
      exitCode: 2,
    };
  }

  private parseHost(): ts.ParseConfigFileHost {
    return {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new RigErrorClass("TYPECHECK_ERROR", "Unable to parse generated Rig tool tsconfig.", {
          diagnostic: ts.formatDiagnostic(diagnostic, this.formatHost()),
        });
      },
    };
  }

  private formatHost(): ts.FormatDiagnosticsHost {
    return {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    };
  }

  private packagePath(packageName: string): string {
    return dirname(this.require.resolve(`${packageName}/package.json`));
  }
}
