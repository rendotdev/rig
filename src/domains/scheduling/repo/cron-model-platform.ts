import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";

export class CronModelPlatformService extends Context.Service<
  CronModelPlatformService,
  {
    readonly readJson: (path: string) => Effect.Effect<unknown, RigError>;
    readonly fileUrlToPath: (url: string) => Effect.Effect<string, RigError>;
    readonly pathToFileUrl: (path: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/scheduling/CronModelPlatformService", {
  make: Effect.gen(function* () {
    const mapError = (cause: unknown) =>
      new RigError({
        code: "CRON_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    const readJson = Effect.fn("CronModelPlatformService.readJson")(function* (path: string) {
      return yield* Effect.tryPromise({
        try: async () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? await Bun.file(path).json()
            : JSON.parse(await readFile(path, "utf8")),
        catch: mapError,
      });
    });
    const fileUrlToPath = Effect.fn("CronModelPlatformService.fileUrlToPath")(function* (
      url: string,
    ) {
      return yield* Effect.try({ try: () => fileURLToPath(url), catch: mapError });
    });
    const pathToFileUrl = Effect.fn("CronModelPlatformService.pathToFileUrl")(function* (
      path: string,
    ) {
      return pathToFileURL(path).href;
    });
    return { readJson, fileUrlToPath, pathToFileUrl } as const;
  }),
}) {
  static readonly layer = Layer.effect(CronModelPlatformService, CronModelPlatformService.make);
}
