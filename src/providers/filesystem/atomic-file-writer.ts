import { randomUUID } from "node:crypto";
import {
  mkdir as nodeMkdir,
  rename as nodeRename,
  rm as nodeRemove,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname as nodeDirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

export class AtomicFileWriterError extends Schema.TaggedErrorClass<AtomicFileWriterError>()(
  "AtomicFileWriterError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class AtomicFileWriterPlatformService extends Context.Service<
  AtomicFileWriterPlatformService,
  {
    readonly mkdir: (path: string) => Effect.Effect<void, AtomicFileWriterError>;
    readonly rename: (
      oldPath: string,
      newPath: string,
    ) => Effect.Effect<void, AtomicFileWriterError>;
    readonly remove: (path: string) => Effect.Effect<void>;
    readonly writeFile: (
      path: string,
      content: string,
    ) => Effect.Effect<void, AtomicFileWriterError>;
    readonly dirname: (path: string) => Effect.Effect<string>;
    readonly randomUuid: Effect.Effect<string>;
    readonly processPid: Effect.Effect<number>;
  }
>()("@rendotdev/rig/settings/AtomicFileWriterPlatformService", {
  make: Effect.gen(function* () {
    const mkdir = Effect.fn("AtomicFileWriterPlatformService.mkdir")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => nodeMkdir(path, { recursive: true }),
        catch: (cause) => new AtomicFileWriterError({ path, cause }),
      });
    });
    const rename = Effect.fn("AtomicFileWriterPlatformService.rename")(function* (
      oldPath: string,
      newPath: string,
    ) {
      yield* Effect.tryPromise({
        try: () => nodeRename(oldPath, newPath),
        catch: (cause) => new AtomicFileWriterError({ path: newPath, cause }),
      });
    });
    const remove = Effect.fn("AtomicFileWriterPlatformService.remove")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => nodeRemove(path, { force: true }),
        catch: (cause) => new AtomicFileWriterError({ path, cause }),
      }).pipe(Effect.ignore);
    });
    const writeFile = Effect.fn("AtomicFileWriterPlatformService.writeFile")(function* (
      path: string,
      content: string,
    ) {
      yield* Effect.tryPromise({
        try: () => nodeWriteFile(path, content, "utf8"),
        catch: (cause) => new AtomicFileWriterError({ path, cause }),
      });
    });
    const dirname = Effect.fn("AtomicFileWriterPlatformService.dirname")(function* (path: string) {
      return nodeDirname(path);
    });
    const randomUuid = Effect.sync(randomUUID).pipe(
      Effect.withSpan("AtomicFileWriterPlatformService.randomUuid"),
    );
    const processPid = Effect.sync(() => process.pid).pipe(
      Effect.withSpan("AtomicFileWriterPlatformService.processPid"),
    );
    return { mkdir, rename, remove, writeFile, dirname, randomUuid, processPid } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AtomicFileWriterPlatformService,
    AtomicFileWriterPlatformService.make,
  );
}

export class AtomicFileWriterService extends Context.Service<
  AtomicFileWriterService,
  {
    readonly write: (path: string, content: string) => Effect.Effect<void, AtomicFileWriterError>;
  }
>()("@rendotdev/rig/settings/AtomicFileWriterService", {
  make: Effect.gen(function* () {
    const platform = yield* AtomicFileWriterPlatformService;

    const write = Effect.fn("AtomicFileWriterService.write")(function* (
      path: string,
      content: string,
    ) {
      const parentDirectory = yield* platform.dirname(path);
      yield* platform.mkdir(parentDirectory).pipe(
        /* v8 ignore next -- platform I/O fault translation is defensive */
        Effect.mapError((cause) => new AtomicFileWriterError({ path, cause })),
      );

      const temporaryPath = `${path}.tmp-${yield* platform.processPid}-${yield* platform.randomUuid}`;
      yield* Effect.acquireUseRelease(
        Effect.succeed(temporaryPath),
        (target) =>
          platform.writeFile(target, content).pipe(
            Effect.andThen(platform.rename(target, path)),
            Effect.mapError((cause) => new AtomicFileWriterError({ path, cause })),
          ),
        (target) => platform.remove(target),
      );
    });

    return { write } as const;
  }),
}) {
  static readonly layer = Layer.effect(AtomicFileWriterService, AtomicFileWriterService.make);
}

export const atomicFileWriterLayer = AtomicFileWriterService.layer.pipe(
  Layer.provide(AtomicFileWriterPlatformService.layer),
);
