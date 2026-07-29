import { readFile } from "node:fs/promises";
import { Context, Effect, Layer, Predicate } from "effect";
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
import { DirectoryMigrationError } from "../types/directory-migration";

type RigMigrationPromptState = {
  version: 1;
  prompts: Record<string, { shownAt: string }>;
};

export class MigrationPromptStoreService extends Context.Service<
  MigrationPromptStoreService,
  {
    readonly hasPrompted: (promptId: string) => Effect.Effect<boolean, DirectoryMigrationError>;
    readonly markPrompted: (promptId: string) => Effect.Effect<void, DirectoryMigrationError>;
  }
>()("@rendotdev/rig/settings/MigrationPromptStoreService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const fileLock = yield* FileLockService;
    const fileWriter = yield* AtomicFileWriterService;
    const emptyPromptState = (): RigMigrationPromptState => ({ version: 1, prompts: {} });
    const isPromptState = (value: unknown): value is RigMigrationPromptState =>
      Predicate.isObject(value) && value.version === 1 && Predicate.isObject(value.prompts);
    const readState = Effect.fn("MigrationPromptStoreService.readState")(function* () {
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const value: unknown = JSON.parse(
              await readFile(paths.migrationPromptStatePath, "utf8"),
            );
            return isPromptState(value) ? value : emptyPromptState();
          } catch {
            return emptyPromptState();
          }
        },
        catch: (cause) => new DirectoryMigrationError({ operation: "hasPrompted", cause }),
      });
    });
    const hasPrompted = Effect.fn("MigrationPromptStoreService.hasPrompted")(function* (
      promptId: string,
    ) {
      return (yield* readState()).prompts[promptId] !== undefined;
    });
    const markPrompted = Effect.fn("MigrationPromptStoreService.markPrompted")(function* (
      promptId: string,
    ) {
      yield* fileLock
        .withLock({
          targetPath: paths.migrationPromptStatePath,
          operation: () =>
            Effect.gen(function* () {
              const state = yield* readState();
              state.prompts[promptId] ??= { shownAt: new Date().toISOString() };
              yield* fileWriter.write(
                paths.migrationPromptStatePath,
                `${JSON.stringify(state, null, 2)}\n`,
              );
            }),
        })
        .pipe(
          Effect.mapError(
            (cause) => new DirectoryMigrationError({ operation: "markPrompted", cause }),
          ),
        );
    });
    return { hasPrompted, markPrompted } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    MigrationPromptStoreService,
    MigrationPromptStoreService.make,
  );
}

export const migrationPromptStoreLayer: Layer.Layer<
  MigrationPromptStoreService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = MigrationPromptStoreService.layer.pipe(
  Layer.provide(Layer.mergeAll(rigPathsConfigLayer, fileLockLayer, atomicFileWriterLayer)),
);
