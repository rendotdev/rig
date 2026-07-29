import { existsSync } from "node:fs";
import { chmod as chmodFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";

export class DevLinkPlatformService extends Context.Service<
  DevLinkPlatformService,
  {
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly chmod: (path: string, mode: number) => Effect.Effect<void, RigError>;
    readonly isFile: (path: string) => Effect.Effect<boolean, RigError>;
    readonly makeDirectory: (path: string) => Effect.Effect<void, RigError>;
    readonly readText: (path: string) => Effect.Effect<string, RigError>;
    readonly remove: (path: string) => Effect.Effect<void, RigError>;
    readonly writeText: (path: string, content: string) => Effect.Effect<void, RigError>;
    readonly join: (parts: string[]) => Effect.Effect<string>;
    readonly resolve: (path: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/updates/DevLinkPlatformService", {
  make: Effect.gen(function* () {
    const asError = (cause: unknown) =>
      new RigError({ code: "DEV_LINK_ERROR", message: String(cause), details: cause });
    const exists = Effect.fn("DevLinkPlatformService.exists")(function* (path: string) {
      return existsSync(path);
    });
    const chmod = Effect.fn("DevLinkPlatformService.chmod")(function* (path: string, mode: number) {
      yield* Effect.tryPromise({ try: () => chmodFile(path, mode), catch: asError });
    });
    const isFile = Effect.fn("DevLinkPlatformService.isFile")(function* (path: string) {
      return yield* Effect.tryPromise({ try: () => lstat(path), catch: asError }).pipe(
        Effect.map((status) => status.isFile()),
      );
    });
    const makeDirectory = Effect.fn("DevLinkPlatformService.makeDirectory")(function* (
      path: string,
    ) {
      yield* Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: asError });
    });
    const readText = Effect.fn("DevLinkPlatformService.readText")(function* (path: string) {
      return yield* Effect.tryPromise({
        try: async () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? await Bun.file(path).text()
            : await readFile(path, "utf8"),
        catch: asError,
      });
    });
    const remove = Effect.fn("DevLinkPlatformService.remove")(function* (path: string) {
      yield* Effect.tryPromise({ try: () => rm(path, { force: true }), catch: asError });
    });
    const writeText = Effect.fn("DevLinkPlatformService.writeText")(function* (
      path: string,
      content: string,
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          const canWriteWithBun = typeof Bun !== "undefined" && typeof Bun.write === "function";
          if (canWriteWithBun) {
            await Bun.write(path, content);
          } else await writeFile(path, content, "utf8");
        },
        catch: asError,
      });
    });
    const join = Effect.fn("DevLinkPlatformService.join")(function* (parts: string[]) {
      return joinPath(...parts);
    });
    const resolve = Effect.fn("DevLinkPlatformService.resolve")(function* (path: string) {
      return resolvePath(path);
    });
    return {
      exists,
      chmod,
      isFile,
      makeDirectory,
      readText,
      remove,
      writeText,
      join,
      resolve,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkPlatformService, DevLinkPlatformService.make);
}

export const devLinkRepositoryLayer = DevLinkPlatformService.layer;
