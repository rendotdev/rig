import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import ts from "typescript";
import { RigConfigStoreService } from "../../settings/service/config-store";
import { RigPathsConfigService } from "../../../providers/paths/rig-paths";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import { ToolDefinitionService } from "../service/tool-definition";

export type ToolTypecheckResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  checked: string[];
  tsconfigPath: string;
};

class ToolTypeScriptCompilerService extends Context.Service<
  ToolTypeScriptCompilerService,
  {
    readonly run: (
      tsconfigPath: string,
    ) => Effect.Effect<{ stdout: string; exitCode: number }, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolTypeScriptCompilerService", {
  make: Effect.gen(function* () {
    const diagnosticsHost = (): ts.FormatDiagnosticsHost => ({
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    });
    const parseHost = (): ts.ParseConfigFileHost => ({
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new RigError({
          code: "TYPECHECK_ERROR",
          message: "Unable to parse generated Rig tool tsconfig.",
          details: { diagnostic: ts.formatDiagnostic(diagnostic, diagnosticsHost()) },
        });
      },
    });
    const compile = (tsconfigPath: string): { stdout: string; exitCode: number } => {
      const parsedConfig = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, parseHost());
      /* v8 ignore next */
      if (!parsedConfig) {
        return { stdout: "Unable to parse generated Rig tool tsconfig.\n", exitCode: 2 };
      }
      const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
      const diagnostics = [...parsedConfig.errors, ...ts.getPreEmitDiagnostics(program)];
      if (diagnostics.length === 0) return { stdout: "", exitCode: 0 };
      return { stdout: ts.formatDiagnostics(diagnostics, diagnosticsHost()), exitCode: 2 };
    };
    const run = Effect.fn("ToolTypeScriptCompilerService.run")(function* (tsconfigPath: string) {
      return yield* Effect.try({
        try: () => compile(tsconfigPath),
        catch: (cause) =>
          cause instanceof RigError
            ? cause
            : new RigError({
                code: "INTERNAL_ERROR",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
      });
    });
    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolTypeScriptCompilerService,
    ToolTypeScriptCompilerService.make,
  );
}

class ToolTypeScriptConfigService extends Context.Service<
  ToolTypeScriptConfigService,
  {
    readonly create: (toolPaths: string[]) => Effect.Effect<Record<string, unknown>, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolTypeScriptConfigService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const requireFromModule = createRequire(import.meta.url);
    const packagePath = (packageName: string): string =>
      dirname(requireFromModule.resolve(`${packageName}/package.json`));
    const create = Effect.fn("ToolTypeScriptConfigService.create")(function* (toolPaths: string[]) {
      return yield* Effect.try({
        try: () => {
          const bunTypesRoot = dirname(packagePath("@types/bun"));
          const zodRoot = packagePath("zod");
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
              paths: { zod: [join(zodRoot, "index.d.ts")] },
            },
            files: [paths.runtimeGlobalsPath, paths.runtimeTypesPath, ...toolPaths],
          };
        },
        catch: (cause) =>
          new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolTypeScriptConfigService,
    ToolTypeScriptConfigService.make,
  );
}

export class ToolTypecheckService extends Context.Service<
  ToolTypecheckService,
  {
    readonly typecheck: (toolName?: string) => Effect.Effect<ToolTypecheckResult, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolTypecheckService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const config = yield* RigConfigStoreService;
    const discovery = yield* ToolDiscoveryService;
    const definitions = yield* ToolDefinitionService;
    const compiler = yield* ToolTypeScriptCompilerService;
    const configurations = yield* ToolTypeScriptConfigService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const typecheck = Effect.fn("ToolTypecheckService.typecheck")(function* (toolName?: string) {
      yield* config.ensure.pipe(Effect.mapError((error) => toError(error.cause)));
      const discovered = yield* discovery.discover();
      if (toolName) yield* definitions.validateToolName(toolName);
      const selected = toolName ? discovered.filter((tool) => tool.name === toolName) : discovered;
      const isSelectedToolMissing = toolName !== undefined && selected.length === 0;
      if (isSelectedToolMissing) {
        return yield* new RigError({
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${toolName}`,
          details: { available: discovered.map((tool) => tool.name) },
        });
      }
      const checked = selected.map((tool) => tool.toolPath);
      const tsconfig = yield* configurations.create(checked);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(paths.runtimeDir, { recursive: true });
          await writeFile(paths.runtimeToolTsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");
        },
        catch: toError,
      });
      const result = yield* compiler.run(paths.runtimeToolTsconfigPath);
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: "",
        checked,
        tsconfigPath: paths.runtimeToolTsconfigPath,
      };
    });
    return { typecheck } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolTypecheckService, ToolTypecheckService.make);
}

const toolTypeScriptCompilerLayer = ToolTypeScriptCompilerService.layer;
const toolTypeScriptConfigLayer = ToolTypeScriptConfigService.layer;
export const toolTypecheckLayer = ToolTypecheckService.layer.pipe(
  Layer.provide(Layer.merge(toolTypeScriptCompilerLayer, toolTypeScriptConfigLayer)),
);
