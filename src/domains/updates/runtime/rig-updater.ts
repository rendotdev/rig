import { Context, Effect, Layer } from "effect";
import { RigUpdaterConfigService } from "../config/rig-updater-config";
import {
  RigUpdateExecutionService,
  rigUpdatePlanningLayer,
  RigUpdatePlanningService,
  rigUpdaterSupportLayer,
} from "../service/rig-update-planning";
import {
  type RigUpdatePlan,
  RigUpdateError,
  type RigUpdateResult,
  type RigUpdateStep,
  type RunnableRigUpdatePlan,
} from "../types/updates";

export class RigUpdaterService extends Context.Service<
  RigUpdaterService,
  {
    readonly currentVersion: Effect.Effect<string>;
    readonly plan: Effect.Effect<RigUpdatePlan, RigUpdateError>;
    readonly update: (plan?: RigUpdatePlan) => Effect.Effect<RigUpdateResult, RigUpdateError>;
    readonly sync: (
      plan: RunnableRigUpdatePlan,
    ) => Effect.Effect<{ step: RigUpdateStep; output: string }, RigUpdateError>;
  }
>()("@rendotdev/rig/updates/RigUpdaterService", {
  make: Effect.gen(function* () {
    const config = yield* RigUpdaterConfigService;
    const execution = yield* RigUpdateExecutionService;
    const planning = yield* RigUpdatePlanningService;
    const currentVersion = Effect.succeed(config.params.currentVersion).pipe(
      Effect.withSpan("RigUpdaterService.currentVersion"),
    );
    const plan = planning.plan.pipe(Effect.withSpan("RigUpdaterService.plan"));
    const update = Effect.fn("RigUpdaterService.update")(function* (provided?: RigUpdatePlan) {
      const updatePlan = provided ?? (yield* plan);
      if (updatePlan.status === "current") {
        return { status: "current" as const, version: updatePlan.version };
      }
      if (updatePlan.status === "skipped") return updatePlan;
      return yield* execution.update(updatePlan);
    });
    const sync = Effect.fn("RigUpdaterService.sync")(function* (updatePlan: RunnableRigUpdatePlan) {
      return yield* execution.sync(updatePlan);
    });
    return { currentVersion, plan, update, sync } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigUpdaterService, RigUpdaterService.make);
}

export const rigUpdaterOperationLayer = RigUpdaterService.layer.pipe(
  Layer.provide(Layer.merge(rigUpdatePlanningLayer, RigUpdateExecutionService.layer)),
);

export const rigUpdaterLayer = RigUpdaterService.layer.pipe(Layer.provide(rigUpdaterSupportLayer));
