import { Context, Effect, Layer } from "effect";
import type { NpmUpdateCheckConfig } from "../types/updates";

export class NpmUpdateCheckConfigService extends Context.Service<
  NpmUpdateCheckConfigService,
  {
    readonly get: Effect.Effect<NpmUpdateCheckConfig>;
  }
>()("@rendotdev/rig/updates/NpmUpdateCheckConfigService", {
  make: Effect.gen(function* () {
    const get = Effect.succeed({
      updateCheckCachePath: "",
      cacheTtlMs: 24 * 60 * 60 * 1000,
      timeoutMs: 750,
      packageName: "@rendotdev/rig",
    } as const).pipe(Effect.withSpan("NpmUpdateCheckConfigService.get"));
    return { get } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    NpmUpdateCheckConfigService,
    NpmUpdateCheckConfigService.make,
  );
}
