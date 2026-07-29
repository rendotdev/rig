import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  NpmUpdateCheckError,
  UpdateCheckCache,
  type UpdateCheckCache as UpdateCheckCacheValue,
} from "../types/updates";

export class NpmUpdateCacheService extends Context.Service<
  NpmUpdateCacheService,
  {
    readonly read: (path: string) => Effect.Effect<UpdateCheckCacheValue, NpmUpdateCheckError>;
    readonly write: (
      path: string,
      cache: UpdateCheckCacheValue,
    ) => Effect.Effect<void, NpmUpdateCheckError>;
  }
>()("@rendotdev/rig/updates/NpmUpdateCacheService", {
  make: Effect.gen(function* () {
    const read = Effect.fn("NpmUpdateCacheService.read")(function* (path: string) {
      const value = yield* Effect.tryPromise({
        try: async () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? await Bun.file(path).json()
            : JSON.parse(await readFile(path, "utf8")),
        catch: (cause) => new NpmUpdateCheckError({ cause }),
      });
      return yield* Schema.decodeUnknownEffect(UpdateCheckCache)(value).pipe(
        Effect.mapError((cause) => new NpmUpdateCheckError({ cause })),
      );
    });
    const write = Effect.fn("NpmUpdateCacheService.write")(function* (
      path: string,
      cache: UpdateCheckCacheValue,
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          const content = `${JSON.stringify(cache, null, 2)}\n`;
          const canWriteWithBun = typeof Bun !== "undefined" && typeof Bun.write === "function";
          if (canWriteWithBun) {
            await Bun.write(path, content);
          } else await writeFile(path, content, "utf8");
        },
        catch: (cause) => new NpmUpdateCheckError({ cause }),
      });
    });
    return { read, write } as const;
  }),
}) {
  static readonly layer = Layer.effect(NpmUpdateCacheService, NpmUpdateCacheService.make);
}

export const npmUpdateCacheLayer = NpmUpdateCacheService.layer;
