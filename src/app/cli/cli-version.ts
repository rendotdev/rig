import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { PackageRootService, packageRootLayer } from "../../providers/package/package-root";
import { CliPlatformService, cliPlatformLayer } from "./cli-platform";

export class CliVersionService extends Context.Service<
  CliVersionService,
  {
    readonly packageRoot: Effect.Effect<string>;
    readonly current: Effect.Effect<string>;
  }
>()("@rendotdev/rig/application/CliVersionService", {
  make: Effect.gen(function* () {
    const packageRootService = yield* PackageRootService;
    const platform = yield* CliPlatformService;
    const packageRoot = packageRootService
      .find(import.meta.url)
      .pipe(Effect.withSpan("CliVersionService.packageRoot"));
    const current = Effect.gen(function* () {
      const root = yield* packageRoot;
      const source = yield* platform.readText(join(root, "package.json"));
      const parsed = yield* Effect.try(() => JSON.parse(source) as { version?: unknown });
      return typeof parsed.version === "string" ? parsed.version : "0.0.0";
    }).pipe(
      Effect.orElseSucceed(() => "0.0.0"),
      Effect.withSpan("CliVersionService.current"),
    );
    return { packageRoot, current } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliVersionService, CliVersionService.make);
}

export const cliVersionLayer = CliVersionService.layer.pipe(
  Layer.provide(Layer.merge(packageRootLayer, cliPlatformLayer)),
);
