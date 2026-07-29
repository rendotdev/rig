import { Context, Effect, Layer } from "effect";
import type { RigCronJob } from "../../settings/types/config-schema";
import {
  RigCronMutationService,
  rigCronOperationsLayer,
  RigCronQueryService,
} from "./rig-cron-operations";
import type { CronAddOptions, CronRunResult } from "../types/cron";
import { RigCronError } from "../types/cron";

export class RigCronService extends Context.Service<
  RigCronService,
  {
    readonly list: Effect.Effect<{ readonly cronJobs: RigCronJob[] }, RigCronError>;
    readonly add: (
      params: CronAddOptions,
    ) => Effect.Effect<{ readonly job: RigCronJob; readonly workerPath: string }, RigCronError>;
    readonly remove: (
      name: string,
    ) => Effect.Effect<
      { readonly name: string; readonly removed: boolean; readonly workerPath: string },
      RigCronError
    >;
    readonly run: (name: string) => Effect.Effect<CronRunResult, RigCronError>;
  }
>()("@rendotdev/rig/scheduling/RigCronService", {
  make: Effect.gen(function* () {
    const queries = yield* RigCronQueryService;
    const mutations = yield* RigCronMutationService;
    const list = queries.list.pipe(Effect.withSpan("RigCronService.list"));
    const add = Effect.fn("RigCronService.add")(function* (params: CronAddOptions) {
      return yield* mutations.add(params);
    });
    const remove = Effect.fn("RigCronService.remove")(function* (name: string) {
      return yield* mutations.remove(name);
    });
    const run = Effect.fn("RigCronService.run")(function* (name: string) {
      return yield* queries.run(name);
    });
    return { list, add, remove, run } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigCronService, RigCronService.make);
}

export const rigCronLayer = RigCronService.layer.pipe(Layer.provide(rigCronOperationsLayer));
