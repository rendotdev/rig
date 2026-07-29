import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolIdentifierService, toolIdentifierLayer } from "../../tools/service/tool-identifier";
import { CronModelPlatformService } from "../repo/cron-model-platform";
import { CronRegistrarService, cronRegistrarLayer } from "../repo/cron-registrar";

export class CronModelService extends Context.Service<
  CronModelService,
  {
    readonly parseJobName: (value: string) => Effect.Effect<string, RigError>;
    readonly parseCommandTarget: (
      id: string,
    ) => Effect.Effect<
      { readonly id: string; readonly tool: string; readonly command: string },
      RigError
    >;
    readonly readInput: (params: {
      readonly input?: string;
      readonly inputFile?: string;
    }) => Effect.Effect<unknown | undefined, RigError>;
    readonly renderWorker: (params: {
      readonly name: string;
      readonly homeDir?: string;
      readonly moduleUrl: string;
    }) => Effect.Effect<string, RigError>;
    readonly moduleUrl: (metaUrl: string) => Effect.Effect<string, RigError>;
    readonly validateSchedule: (schedule: string) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/scheduling/CronModelService", {
  make: Effect.gen(function* () {
    const platform = yield* CronModelPlatformService;
    const identifiers = yield* ToolIdentifierService;
    const registrar = yield* CronRegistrarService;
    const parseJobName = Effect.fn("CronModelService.parseJobName")(function* (value: string) {
      if (/^[A-Za-z0-9_-]+$/u.test(value)) return value;
      return yield* new RigError({
        code: "INPUT_ERROR",
        message: "Cron job names may only contain letters, numbers, hyphens, and underscores.",
        details: { name: value },
      });
    });
    const parseCommandTarget = Effect.fn("CronModelService.parseCommandTarget")(function* (
      id: string,
    ) {
      const target = yield* identifiers.parseCommandTarget(id);
      return { id, tool: target.tool, command: target.command } as const;
    });
    const readInput = Effect.fn("CronModelService.readInput")(function* (params: {
      readonly input?: string;
      readonly inputFile?: string;
    }) {
      const hasConflictingInputSources = Boolean(params.input && params.inputFile);
      if (hasConflictingInputSources) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: "Use --input or --input-file, not both.",
        });
      }
      if (params.inputFile) return yield* platform.readJson(params.inputFile);
      if (params.input === undefined) return undefined;
      return yield* Effect.try({
        try: () => JSON.parse(params.input!) as unknown,
        catch: (cause) =>
          new RigError({ code: "INPUT_ERROR", message: "Input JSON is invalid.", details: cause }),
      });
    });
    const renderWorker = Effect.fn("CronModelService.renderWorker")(function* (params: {
      readonly name: string;
      readonly homeDir?: string;
      readonly moduleUrl: string;
    }) {
      const entrypoint = yield* platform.fileUrlToPath(params.moduleUrl);
      const environment = params.homeDir ? { RIG_HOME: params.homeDir } : {};
      return `export default {\n  async scheduled() {\n    const proc = Bun.spawn([\n      process.execPath,\n      "--install=fallback",\n      ${JSON.stringify(entrypoint)},\n      "cron",\n      "run",\n      ${JSON.stringify(params.name)},\n    ], {\n      stdout: "pipe",\n      stderr: "pipe",\n      env: { ...process.env, ...${JSON.stringify(environment)} },\n    });\n\n    const [stdout, stderr, exitCode] = await Promise.all([\n      new Response(proc.stdout).text(),\n      new Response(proc.stderr).text(),\n      proc.exited,\n    ]);\n    if (stdout) console.log(stdout.trimEnd());\n    if (stderr) console.error(stderr.trimEnd());\n    if (exitCode !== 0) throw new Error("Rig cron job failed: " + ${JSON.stringify(params.name)});\n  },\n};\n`;
    });
    const moduleUrl = Effect.fn("CronModelService.moduleUrl")(function* (metaUrl: string) {
      return yield* platform.pathToFileUrl(yield* platform.fileUrlToPath(metaUrl));
    });
    const validateSchedule = Effect.fn("CronModelService.validateSchedule")(function* (
      schedule: string,
    ) {
      yield* registrar.validate(schedule);
    });
    return {
      parseJobName,
      parseCommandTarget,
      readInput,
      renderWorker,
      moduleUrl,
      validateSchedule,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(CronModelService, CronModelService.make);
}

export const cronModelLayer = CronModelService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(CronModelPlatformService.layer, toolIdentifierLayer, cronRegistrarLayer),
  ),
);
