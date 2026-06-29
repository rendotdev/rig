import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { RigConfigStore, type ConfigOptions } from "../config/config";
import { RigPaths } from "../config/paths";
import { RigError } from "../errors/RigError";
import { ToolDiscoveryService } from "../registry/discover";
import { RigPackageRoot } from "../runtime/package-root";
import { ToolLoader } from "./loader";

export type ToolTypecheckResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  checked: string[];
  tsconfigPath: string;
};

export class ToolTypecheckService {
  private readonly configStore: RigConfigStore;
  private readonly discovery: ToolDiscoveryService;
  private readonly loader: ToolLoader;
  private readonly paths: RigPaths;

  constructor(private readonly options: ConfigOptions = {}) {
    this.configStore = new RigConfigStore(options);
    this.discovery = new ToolDiscoveryService(options);
    this.loader = new ToolLoader(options);
    this.paths = new RigPaths(options);
  }

  async typecheck(toolName?: string): Promise<ToolTypecheckResult> {
    await this.configStore.ensure();
    const discovered = await this.discovery.discover();
    const selected = toolName ? discovered.filter((tool) => tool.name === toolName) : discovered;

    if (toolName) {
      this.loader.validateToolName(toolName);
      if (selected.length === 0) {
        throw new RigError("TOOL_NOT_FOUND", `Tool not found: ${toolName}`, {
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
    const packageRoot = this.packageRoot();
    return {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        ignoreDeprecations: "6.0",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        lib: ["ES2023", "DOM"],
        jsx: "preserve",
        types: ["bun"],
        typeRoots: [join(packageRoot, "node_modules/@types")],
        baseUrl: packageRoot,
        paths: {
          zod: [join(packageRoot, "node_modules/zod/index.d.ts")],
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
        throw new RigError("TYPECHECK_ERROR", "Unable to parse generated Rig tool tsconfig.", {
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

  private packageRoot(): string {
    return RigPackageRoot.find(import.meta.url);
  }
}
