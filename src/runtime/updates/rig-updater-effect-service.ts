import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  RigUpdatePlan,
  RigUpdateResult,
  RigUpdateStep,
  RunnableRigUpdatePlan,
} from "./rig-updater";

export const RigUpdateOperation = Schema.Literals(["command", "plan", "update", "sync"]);
export type RigUpdateOperation = typeof RigUpdateOperation.Type;

export class RigUpdateError extends Schema.TaggedErrorClass<RigUpdateError>()("RigUpdateError", {
  operation: RigUpdateOperation,
  cause: Schema.Defect(),
}) {}

export type RigUpdaterRuntimeServiceShape = Readonly<{
  plan: Effect.Effect<RigUpdatePlan, RigUpdateError>;
  update: (plan?: RigUpdatePlan) => Effect.Effect<RigUpdateResult, RigUpdateError>;
  sync: (
    plan: RunnableRigUpdatePlan,
  ) => Effect.Effect<{ step: RigUpdateStep; output: string }, RigUpdateError>;
}>;

export class RigUpdaterRuntimeService extends Context.Service<
  RigUpdaterRuntimeService,
  RigUpdaterRuntimeServiceShape
>()("@rendotdev/rig/updates/RigUpdaterRuntimeService") {
  public static readonly makeLayer = (
    implementation: RigUpdaterRuntimeServiceShape,
  ): Layer.Layer<RigUpdaterRuntimeService> =>
    Layer.succeed(RigUpdaterRuntimeService, implementation);
}

type RigUpdaterImplementation = {
  plan(params: {}): Promise<RigUpdatePlan>;
  update(params: { plan?: RigUpdatePlan }): Promise<RigUpdateResult>;
  sync(params: { plan: RunnableRigUpdatePlan }): Promise<{
    step: RigUpdateStep;
    output: string;
  }>;
};

function attempt<Result>(
  operation: RigUpdateOperation,
  run: () => Promise<Result>,
): Effect.Effect<Result, RigUpdateError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RigUpdateError({ operation, cause }),
  }).pipe(Effect.withSpan(`RigUpdaterRuntimeService.${operation}`));
}

export function makeRigUpdaterLayer(
  implementation: RigUpdaterImplementation,
): Layer.Layer<RigUpdaterRuntimeService> {
  return RigUpdaterRuntimeService.makeLayer({
    plan: attempt("plan", () => implementation.plan({})),
    update: (plan) => attempt("update", () => implementation.update({ plan })),
    sync: (plan) => attempt("sync", () => implementation.sync({ plan })),
  });
}

function runUpdaterEffect<Result>(
  effect: Effect.Effect<Result, RigUpdateError, RigUpdaterRuntimeService>,
  layer: Layer.Layer<RigUpdaterRuntimeService>,
): Promise<Result> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.mapError((error) => error.cause),
    ),
  );
}

export function planUpdate(layer: Layer.Layer<RigUpdaterRuntimeService>) {
  return runUpdaterEffect(
    Effect.gen(function* () {
      const updater = yield* RigUpdaterRuntimeService;
      return yield* updater.plan;
    }),
    layer,
  );
}

export function applyUpdate(layer: Layer.Layer<RigUpdaterRuntimeService>, plan?: RigUpdatePlan) {
  return runUpdaterEffect(
    Effect.gen(function* () {
      const updater = yield* RigUpdaterRuntimeService;
      return yield* updater.update(plan);
    }),
    layer,
  );
}

export function syncUpdate(
  layer: Layer.Layer<RigUpdaterRuntimeService>,
  plan: RunnableRigUpdatePlan,
) {
  return runUpdaterEffect(
    Effect.gen(function* () {
      const updater = yield* RigUpdaterRuntimeService;
      return yield* updater.sync(plan);
    }),
    layer,
  );
}
