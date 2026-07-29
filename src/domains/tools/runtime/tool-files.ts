import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigConfigStoreService } from "../../settings/service/config-store";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import { AtomicFileWriterService } from "../../../providers/filesystem/atomic-file-writer";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import { RigToolEntryFiles } from "../../registry/types/tool-discovery";
import { CurrentRigToolApiVersion } from "../config/tool-api";
import { ToolDefinitionService } from "../service/tool-definition";

export type ToolFileResult = {
  name: string;
  toolDir: string;
  toolPath: string;
};

export class ToolFilesService extends Context.Service<
  ToolFilesService,
  {
    readonly renderTemplate: Effect.Effect<string>;
    readonly create: (
      name: string,
    ) => Effect.Effect<ToolFileResult & { command: string; id: string; files: string[] }, RigError>;
    readonly path: (name: string) => Effect.Effect<ToolFileResult, RigError>;
    readonly remove: (name: string) => Effect.Effect<ToolFileResult, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolFilesService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsService;
    const config = yield* RigConfigStoreService;
    const discovery = yield* ToolDiscoveryService;
    const definitions = yield* ToolDefinitionService;
    const writer = yield* AtomicFileWriterService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const renderTemplate = Effect.succeed(`// rig:tool-api-version ${CurrentRigToolApiVersion}
export default (rig: RigToolKit) => rig.defineTool({
  description: "Describe what this tool does.",
  commands: (command) => ({
    example: command({
      description: "Example command. Replace this with a real command.",
      input: rig.z.object({ text: rig.z.string().default("example") }),
      output: rig.z.object({ text: rig.z.string() }),
      examples: [{
        title: "Run the example command",
        text: "Use this to verify Rig can run a local command.",
        input: { text: "example" },
        output: { text: "example" },
      }],
      run: async ({ input }) => ({ text: input.text }),
    }),
  }),
});
`).pipe(Effect.withSpan("ToolFilesService.renderTemplate"));

    const path = Effect.fn("ToolFilesService.path")(function* (name: string) {
      yield* definitions.validateToolName(name);
      const tool = yield* discovery.find(name);
      return { name: tool.name, toolDir: tool.toolDir, toolPath: tool.toolPath };
    });

    const create = Effect.fn("ToolFilesService.create")(function* (name: string) {
      yield* definitions.validateToolName(name);
      const current = yield* config.ensure.pipe(
        /* v8 ignore next -- config errors are already typed before this boundary */
        Effect.mapError((error) => toError(error.cause)),
      );
      const toolDir = join(yield* paths.resolve(current.baseRegistryDir), name);
      const toolPath = join(toolDir, RigToolEntryFiles[0]);
      if (existsSync(toolDir)) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Tool already exists: ${name}`,
          details: { path: toolDir },
        });
      }
      const template = yield* renderTemplate;
      yield* Effect.tryPromise({
        try: () => mkdir(toolDir, { recursive: true }),
        catch: toError,
      });
      yield* writer.write(toolPath, template).pipe(
        Effect.mapError((error) => toError(error.cause)),
        /* v8 ignore next -- cleanup after a platform write failure is defensive */
        Effect.tapError(() => Effect.promise(() => rm(toolDir, { recursive: true, force: true }))),
      );
      return {
        name,
        command: "example",
        id: `${name}.example`,
        toolDir,
        toolPath,
        files: [toolPath],
      };
    });

    const remove = Effect.fn("ToolFilesService.remove")(function* (name: string) {
      const tool = yield* path(name);
      yield* Effect.tryPromise({
        try: () => rm(tool.toolDir, { recursive: true, force: false }),
        catch: toError,
      });
      return tool;
    });

    return { renderTemplate, create, path, remove } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolFilesService, ToolFilesService.make);
}
