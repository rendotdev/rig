import { Context, Effect, Layer } from "effect";
import {
  RigPathsConfigService,
  RigPathsService,
  rigPathsLayer,
} from "../../../providers/paths/rig-paths";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolRunnerService } from "../../tools/runtime/tool-runner";
import { toolServicesLayer } from "../../tools/runtime/tool-services-layer";
import { RigConfigStoreService, rigConfigStoreLayer } from "../../settings/service/config-store";
import type { RigCronJob } from "../../settings/types/config-schema";
import type { CronAddOptions, CronRunResult } from "../types/cron";
import { CronModelService, cronModelLayer } from "../service/cron-model";
import {
  CronStateTransactionService,
  cronStateTransactionLayer,
} from "../service/cron-state-transaction";
import { RigCronError } from "../types/cron";

class RigCronToolService extends Context.Service<
  RigCronToolService,
  {
    readonly validate: (params: {
      readonly id: string;
      readonly tool: string;
      readonly command: string;
      readonly input: unknown;
    }) => Effect.Effect<void, RigError>;
    readonly runJob: (
      job: RigCronJob,
    ) => Effect.Effect<{ readonly envelope: unknown; readonly exitCode: number }, RigError>;
  }
>()("@rendotdev/rig/cron/RigCronToolService", {
  make: Effect.gen(function* () {
    const runner = yield* ToolRunnerService;
    const model = yield* CronModelService;
    const validate = Effect.fn("RigCronToolService.validate")(function* (params: {
      readonly id: string;
      readonly tool: string;
      readonly command: string;
      readonly input: unknown;
    }) {
      const result = yield* runner.run(params.tool, params.command, {
        input: params.input === undefined ? undefined : JSON.stringify(params.input),
        dryRun: true,
      });
      if (result.exitCode !== 0) {
        return yield* new RigError({
          code: "CRON_ERROR",
          message: `Cron command validation failed: ${params.id}`,
          details: { envelope: result.envelope },
        });
      }
      return undefined;
    });
    const runJob = Effect.fn("RigCronToolService.runJob")(function* (job: RigCronJob) {
      const target = yield* model.parseCommandTarget(job.command);
      return yield* runner.run(target.tool, target.command, {
        input: job.input === undefined ? undefined : JSON.stringify(job.input),
      });
    });
    return { validate, runJob } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigCronToolService, RigCronToolService.make);
}

export class RigCronQueryService extends Context.Service<
  RigCronQueryService,
  {
    readonly list: Effect.Effect<{ readonly cronJobs: RigCronJob[] }, RigCronError>;
    readonly run: (name: string) => Effect.Effect<CronRunResult, RigCronError>;
  }
>()("@rendotdev/rig/cron/RigCronQueryService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const model = yield* CronModelService;
    const tools = yield* RigCronToolService;
    const list = config.ensure.pipe(
      Effect.map((value) => ({
        cronJobs: [...value.cronJobs].toSorted((left, right) =>
          left.name.localeCompare(right.name),
        ),
      })),
      Effect.mapError((cause) => new RigCronError({ operation: "list", cause })),
      Effect.withSpan("RigCronQueryService.list"),
    );
    const run = Effect.fn("RigCronQueryService.run")(function* (nameValue: string) {
      const name = yield* model
        .parseJobName(nameValue)
        .pipe(Effect.mapError((cause) => new RigCronError({ operation: "run", cause })));
      const current = yield* config.ensure.pipe(
        Effect.mapError((cause) => new RigCronError({ operation: "run", cause })),
      );
      const job = current.cronJobs.find((candidate) => candidate.name === name);
      if (!job) {
        return yield* new RigCronError({
          operation: "run",
          cause: new RigError({
            code: "CRON_ERROR",
            message: `Cron job not found: ${name}`,
            details: { name },
          }),
        });
      }
      const result = yield* tools
        .runJob(job)
        .pipe(Effect.mapError((cause) => new RigCronError({ operation: "run", cause })));
      return { job, envelope: result.envelope, exitCode: result.exitCode };
    });
    return { list, run } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigCronQueryService, RigCronQueryService.make);
}

export class RigCronMutationService extends Context.Service<
  RigCronMutationService,
  {
    readonly add: (
      params: CronAddOptions,
    ) => Effect.Effect<{ readonly job: RigCronJob; readonly workerPath: string }, RigCronError>;
    readonly remove: (
      name: string,
    ) => Effect.Effect<
      { readonly name: string; readonly removed: boolean; readonly workerPath: string },
      RigCronError
    >;
  }
>()("@rendotdev/rig/cron/RigCronMutationService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const pathValues = yield* RigPathsConfigService;
    const paths = yield* RigPathsService;
    const model = yield* CronModelService;
    const transaction = yield* CronStateTransactionService;
    const tools = yield* RigCronToolService;
    const mapError = (operation: "add" | "remove") => (cause: unknown) =>
      new RigCronError({ operation, cause });
    const add = Effect.fn("RigCronMutationService.add")(function* (options: CronAddOptions) {
      const name = yield* model.parseJobName(options.name).pipe(Effect.mapError(mapError("add")));
      const target = yield* model
        .parseCommandTarget(options.command)
        .pipe(Effect.mapError(mapError("add")));
      const input = yield* model.readInput(options).pipe(Effect.mapError(mapError("add")));
      yield* model.validateSchedule(options.schedule).pipe(Effect.mapError(mapError("add")));
      yield* tools.validate({ ...target, input }).pipe(Effect.mapError(mapError("add")));
      yield* config.ensure.pipe(Effect.mapError(mapError("add")));
      const job: RigCronJob = {
        name,
        command: target.id,
        schedule: options.schedule,
        ...(input === undefined ? {} : { input }),
      };
      const workerPath = yield* paths.cronWorkerPath(name);
      const workerSource = yield* model
        .renderWorker({ name, homeDir: pathValues.homeDir, moduleUrl: options.moduleUrl })
        .pipe(Effect.mapError(mapError("add")));
      const snapshot = yield* transaction
        .snapshot(workerPath)
        .pipe(Effect.mapError(mapError("add")));
      yield* transaction
        .replace({ snapshot, workerPath, workerSource, job })
        .pipe(Effect.mapError(mapError("add")));
      return { job, workerPath };
    });
    const remove = Effect.fn("RigCronMutationService.remove")(function* (nameValue: string) {
      const name = yield* model.parseJobName(nameValue).pipe(Effect.mapError(mapError("remove")));
      yield* config.ensure.pipe(Effect.mapError(mapError("remove")));
      const workerPath = yield* paths.cronWorkerPath(name);
      const snapshot = yield* transaction
        .snapshot(workerPath)
        .pipe(Effect.mapError(mapError("remove")));
      const removed = yield* transaction
        .remove({ snapshot, workerPath, name })
        .pipe(Effect.mapError(mapError("remove")));
      return { name, removed, workerPath };
    });
    return { add, remove } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigCronMutationService, RigCronMutationService.make);
}

const rigCronToolLayer = RigCronToolService.layer.pipe(
  Layer.provide(Layer.merge(toolServicesLayer, cronModelLayer)),
);
const cronTransactionConfiguredLayer = cronStateTransactionLayer.pipe(
  Layer.provide(rigConfigStoreLayer),
);
const rigCronQueryLayer = RigCronQueryService.layer.pipe(
  Layer.provide(Layer.mergeAll(rigConfigStoreLayer, cronModelLayer, rigCronToolLayer)),
);
const rigCronMutationLayer = RigCronMutationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigConfigStoreLayer,
      rigPathsLayer,
      cronModelLayer,
      cronTransactionConfiguredLayer,
      rigCronToolLayer,
    ),
  ),
);

export const rigCronOperationsLayer = Layer.merge(rigCronQueryLayer, rigCronMutationLayer);
