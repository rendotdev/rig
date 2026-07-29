import { Effect, Layer } from "effect";
import { RigPathsConfigService, rigPathsConfigLayer } from "../../../providers/paths/rig-paths";
import { NpmUpdateCheckConfigService } from "../config/npm-update-check-config";
import { npmUpdateCheckServiceLayer } from "../service/npm-update-check";

const npmUpdateCheckConfigLayer = Layer.effect(
  NpmUpdateCheckConfigService,
  Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const get = Effect.succeed({
      updateCheckCachePath: paths.updateCheckCachePath,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      timeoutMs: 750,
      packageName: "@rendotdev/rig",
    } as const).pipe(Effect.withSpan("NpmUpdateCheckConfigService.get"));
    return { get } as const;
  }),
).pipe(Layer.provide(rigPathsConfigLayer));

export const npmUpdateCheckLayer = npmUpdateCheckServiceLayer.pipe(
  Layer.provide(npmUpdateCheckConfigLayer),
);
