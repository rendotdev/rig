import { Context, Effect, Layer } from "effect";
import type { DevLinkConfig } from "../types/dev-link";

export class DevLinkConfigService extends Context.Service<
  DevLinkConfigService,
  {
    readonly get: Effect.Effect<DevLinkConfig>;
  }
>()("@rendotdev/rig/updates/DevLinkConfigService", {
  make: Effect.gen(function* () {
    const get = Effect.succeed({
      homeDir: "",
      repoRoot: process.cwd(),
      platform: process.platform,
      pathEnvironment: process.env.PATH ?? "",
      pathDelimiter: process.platform === "win32" ? ";" : ":",
    } as const).pipe(Effect.withSpan("DevLinkConfigService.get"));
    return { get } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkConfigService, DevLinkConfigService.make);
}
