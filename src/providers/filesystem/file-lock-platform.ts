import { mkdir, readFile, rename as nodeRename, rm, stat, writeFile } from "node:fs/promises";
import { Context, Effect, Layer, Schema } from "effect";

export class FileLockPlatformError extends Schema.TaggedErrorClass<FileLockPlatformError>()(
  "FileLockPlatformError",
  { cause: Schema.Defect() },
) {}

export class FileLockPlatformService extends Context.Service<
  FileLockPlatformService,
  {
    readonly makeDirectory: (
      path: string,
      recursive: boolean,
    ) => Effect.Effect<void, FileLockPlatformError>;
    readonly readText: (path: string) => Effect.Effect<string, FileLockPlatformError>;
    readonly rename: (
      oldPath: string,
      newPath: string,
    ) => Effect.Effect<void, FileLockPlatformError>;
    readonly removeDirectory: (path: string) => Effect.Effect<void, FileLockPlatformError>;
    readonly modifiedAt: (path: string) => Effect.Effect<number, FileLockPlatformError>;
    readonly writeText: (
      path: string,
      content: string,
    ) => Effect.Effect<void, FileLockPlatformError>;
  }
>()("@rendotdev/rig/settings/FileLockPlatformService", {
  make: Effect.gen(function* () {
    const platformError = (cause: unknown) => new FileLockPlatformError({ cause });
    const makeDirectory = Effect.fn("FileLockPlatformService.makeDirectory")(function* (
      path: string,
      recursive: boolean,
    ) {
      yield* Effect.tryPromise({
        try: () => mkdir(path, recursive ? { recursive: true } : undefined),
        catch: platformError,
      });
    });
    const readText = Effect.fn("FileLockPlatformService.readText")(function* (path: string) {
      return yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: platformError });
    });
    const rename = Effect.fn("FileLockPlatformService.rename")(function* (
      oldPath: string,
      newPath: string,
    ) {
      yield* Effect.tryPromise({ try: () => nodeRename(oldPath, newPath), catch: platformError });
    });
    const removeDirectory = Effect.fn("FileLockPlatformService.removeDirectory")(function* (
      path: string,
    ) {
      yield* Effect.tryPromise({
        try: () => rm(path, { recursive: true, force: true }),
        catch: platformError,
      });
    });
    const modifiedAt = Effect.fn("FileLockPlatformService.modifiedAt")(function* (path: string) {
      return (yield* Effect.tryPromise({
        try: () => stat(path),
        catch: platformError,
      })).mtimeMs;
    });
    const writeText = Effect.fn("FileLockPlatformService.writeText")(function* (
      path: string,
      content: string,
    ) {
      yield* Effect.tryPromise({
        try: () => writeFile(path, content, "utf8"),
        catch: platformError,
      });
    });
    return { makeDirectory, readText, rename, removeDirectory, modifiedAt, writeText } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockPlatformService, FileLockPlatformService.make);
}
