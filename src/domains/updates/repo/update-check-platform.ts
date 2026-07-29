import { Context, Effect, Layer } from "effect";

export class NpmUpdateCheckPlatformService extends Context.Service<
  NpmUpdateCheckPlatformService,
  {
    readonly now: Effect.Effect<number>;
    readonly environmentFlag: (name: string) => Effect.Effect<string | undefined>;
  }
>()("@rendotdev/rig/updates/NpmUpdateCheckPlatformService", {
  make: Effect.gen(function* () {
    const now = Effect.sync(() => Date.now()).pipe(
      Effect.withSpan("NpmUpdateCheckPlatformService.now"),
    );
    const environmentFlag = Effect.fn("NpmUpdateCheckPlatformService.environmentFlag")(function* (
      name: string,
    ) {
      return process.env[name];
    });
    return { now, environmentFlag } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    NpmUpdateCheckPlatformService,
    NpmUpdateCheckPlatformService.make,
  );
}

export const npmUpdateCheckPlatformLayer = NpmUpdateCheckPlatformService.layer;
