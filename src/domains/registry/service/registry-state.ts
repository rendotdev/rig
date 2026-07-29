import { Context, Effect, Layer } from "effect";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import type { RegistryConfigInput, RegistryConfigState } from "../types/registry";

export class RegistryStateService extends Context.Service<
  RegistryStateService,
  {
    readonly forConfig: (current: RegistryConfigInput) => Effect.Effect<RegistryConfigState>;
  }
>()("@rendotdev/rig/registry/RegistryStateService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsService;
    const forConfig = Effect.fn("RegistryStateService.forConfig")(function* (
      current: RegistryConfigInput,
    ) {
      const baseRegistryDir = yield* paths.resolve(current.baseRegistryDir);
      const customRegistries = yield* Effect.forEach(current.customRegistries, paths.resolve);
      return {
        baseRegistryDir,
        customRegistries,
        registries: [
          { kind: "base" as const, path: baseRegistryDir },
          ...customRegistries.map((path) => ({ kind: "custom" as const, path })),
        ],
      };
    });
    return { forConfig } as const;
  }),
}) {
  static readonly layer = Layer.effect(RegistryStateService, RegistryStateService.make);
}
