import { Context, Effect, Layer } from "effect";
import type { RigConfig } from "../types/config-schema";

export class RigConfigDefaultsService extends Context.Service<
  RigConfigDefaultsService,
  {
    readonly get: Effect.Effect<RigConfig>;
  }
>()("@rendotdev/rig/settings/RigConfigDefaultsService", {
  make: Effect.gen(function* () {
    const get = Effect.succeed({
      version: 1 as const,
      baseRegistryDir: "~/rig/tools",
      customRegistries: [],
      cronJobs: [],
    } satisfies RigConfig).pipe(Effect.withSpan("RigConfigDefaultsService.get"));

    return { get } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigConfigDefaultsService, RigConfigDefaultsService.make);
}
