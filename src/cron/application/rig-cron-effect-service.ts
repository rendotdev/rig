import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RigCronJob } from "../../config/schema";
import type { CronAddOptions, CronRunResult } from "./rig-cron";

export const RigCronOperation = Schema.Literals(["list", "add", "remove", "run"]);
export type RigCronOperation = typeof RigCronOperation.Type;

export class RigCronError extends Schema.TaggedErrorClass<RigCronError>()("RigCronError", {
  operation: RigCronOperation,
  cause: Schema.Defect(),
}) {}

export type RigCronRuntimeServiceShape = Readonly<{
  list: Effect.Effect<{ cronJobs: RigCronJob[] }, RigCronError>;
  add: (
    params: CronAddOptions,
  ) => Effect.Effect<{ job: RigCronJob; workerPath: string }, RigCronError>;
  remove: (
    name: string,
  ) => Effect.Effect<{ name: string; removed: boolean; workerPath: string }, RigCronError>;
  run: (name: string) => Effect.Effect<CronRunResult, RigCronError>;
}>;

export class RigCronRuntimeService extends Context.Service<
  RigCronRuntimeService,
  RigCronRuntimeServiceShape
>()("@rendotdev/rig/scheduling/RigCronRuntimeService") {
  public static readonly makeLayer = (
    implementation: RigCronRuntimeServiceShape,
  ): Layer.Layer<RigCronRuntimeService> => Layer.succeed(RigCronRuntimeService, implementation);
}

type RigCronImplementation = {
  list(params: {}): Promise<{ cronJobs: RigCronJob[] }>;
  add(params: CronAddOptions): Promise<{ job: RigCronJob; workerPath: string }>;
  remove(params: { name: string }): Promise<{
    name: string;
    removed: boolean;
    workerPath: string;
  }>;
  run(params: { name: string }): Promise<CronRunResult>;
};

function attempt<Result>(
  operation: RigCronOperation,
  run: () => Promise<Result>,
): Effect.Effect<Result, RigCronError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RigCronError({ operation, cause }),
  }).pipe(Effect.withSpan(`RigCronRuntimeService.${operation}`));
}

export function makeRigCronLayer(
  implementation: RigCronImplementation,
): Layer.Layer<RigCronRuntimeService> {
  return RigCronRuntimeService.makeLayer({
    list: attempt("list", () => implementation.list({})),
    add: (params) => attempt("add", () => implementation.add(params)),
    remove: (name) => attempt("remove", () => implementation.remove({ name })),
    run: (name) => attempt("run", () => implementation.run({ name })),
  });
}

function runCronEffect<Result>(
  effect: Effect.Effect<Result, RigCronError, RigCronRuntimeService>,
  layer: Layer.Layer<RigCronRuntimeService>,
): Promise<Result> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.mapError((error) => error.cause),
    ),
  );
}

export function listCron(layer: Layer.Layer<RigCronRuntimeService>) {
  return runCronEffect(
    Effect.gen(function* () {
      const cron = yield* RigCronRuntimeService;
      return yield* cron.list;
    }),
    layer,
  );
}

export function addCron(layer: Layer.Layer<RigCronRuntimeService>, params: CronAddOptions) {
  return runCronEffect(
    Effect.gen(function* () {
      const cron = yield* RigCronRuntimeService;
      return yield* cron.add(params);
    }),
    layer,
  );
}

export function removeCron(layer: Layer.Layer<RigCronRuntimeService>, name: string) {
  return runCronEffect(
    Effect.gen(function* () {
      const cron = yield* RigCronRuntimeService;
      return yield* cron.remove(name);
    }),
    layer,
  );
}

export function runCron(layer: Layer.Layer<RigCronRuntimeService>, name: string) {
  return runCronEffect(
    Effect.gen(function* () {
      const cron = yield* RigCronRuntimeService;
      return yield* cron.run(name);
    }),
    layer,
  );
}
