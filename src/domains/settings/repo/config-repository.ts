import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import {
  AtomicFileWriterService,
  atomicFileWriterLayer,
} from "../../../providers/filesystem/atomic-file-writer";
import { FileLockService, fileLockLayer } from "../../../providers/filesystem/file-lock";
import {
  RigPathsConfigService,
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  rigPathsConfigLayer,
} from "../../../providers/paths/rig-paths";
import { RigConfigDefaultsService } from "../config/config-defaults";
import { RigConfigError, type RigConfigOperation } from "../types/config-error";
import type { RigConfig } from "../types/config-schema";
import type { RigConfigMutator } from "../types/config-store";
import { RigConfigCodecService, rigConfigCodecLayer } from "./config-codec";

export class RigConfigRepositoryService extends Context.Service<
  RigConfigRepositoryService,
  {
    readonly initialize: Effect.Effect<RigConfig, RigConfigError>;
    readonly read: Effect.Effect<RigConfig, RigConfigError>;
    readonly write: (config: RigConfig) => Effect.Effect<void, RigConfigError>;
    readonly update: (mutator: RigConfigMutator) => Effect.Effect<RigConfig, RigConfigError>;
  }
>()("@rendotdev/rig/settings/RigConfigRepositoryService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const locks = yield* FileLockService;
    const writer = yield* AtomicFileWriterService;
    const defaults = yield* RigConfigDefaultsService;
    const codec = yield* RigConfigCodecService;
    const mapError = (operation: RigConfigOperation) => (cause: unknown) =>
      new RigConfigError({ operation, cause });
    const readUnlocked = Effect.tryPromise({
      try: () => readFile(paths.configPath, "utf8"),
      catch: mapError("read"),
    }).pipe(
      Effect.flatMap((raw) =>
        codec.decode(raw, paths.configPath).pipe(Effect.mapError(mapError("read"))),
      ),
      Effect.withSpan("RigConfigRepositoryService.readUnlocked"),
    );
    const writeUnlocked = Effect.fn("RigConfigRepositoryService.writeUnlocked")(
      function* (config: RigConfig) {
        const valid = yield* codec.validate(config);
        yield* writer.write(paths.configPath, `${JSON.stringify(valid, null, 2)}\n`);
        return valid;
      },
      Effect.mapError(mapError("write")),
    );
    const read = readUnlocked.pipe(Effect.withSpan("RigConfigRepositoryService.read"));
    const initialize = locks
      .withLock({
        targetPath: paths.configPath,
        operation: () =>
          existsSync(paths.configPath)
            ? readUnlocked
            : defaults.get.pipe(Effect.flatMap(writeUnlocked)),
      })
      .pipe(
        Effect.mapError(mapError("ensure")),
        Effect.withSpan("RigConfigRepositoryService.initialize"),
      );
    const write = Effect.fn("RigConfigRepositoryService.write")(function* (config: RigConfig) {
      yield* locks
        .withLock({
          targetPath: paths.configPath,
          operation: () => writeUnlocked(config),
        })
        .pipe(Effect.mapError(mapError("write")));
    });
    const update = Effect.fn("RigConfigRepositoryService.update")(function* (
      mutator: RigConfigMutator,
    ) {
      return yield* locks
        .withLock({
          targetPath: paths.configPath,
          operation: () =>
            Effect.gen(function* () {
              const current = existsSync(paths.configPath)
                ? yield* readUnlocked
                : yield* defaults.get;
              const next = yield* Effect.tryPromise({
                try: () => Promise.resolve(mutator(current)),
                catch: mapError("update"),
              });
              return yield* writeUnlocked(next).pipe(Effect.mapError(mapError("update")));
            }),
        })
        .pipe(Effect.mapError(mapError("update")));
    });
    return { initialize, read, write, update } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigConfigRepositoryService, RigConfigRepositoryService.make);
}

export const rigConfigRepositoryLayer: Layer.Layer<
  RigConfigRepositoryService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = RigConfigRepositoryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsConfigLayer,
      fileLockLayer,
      atomicFileWriterLayer,
      RigConfigDefaultsService.layer,
      rigConfigCodecLayer,
    ),
  ),
);
