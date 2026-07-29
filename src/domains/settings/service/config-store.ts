import { Context, Effect, Layer } from "effect";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  rigPathsConfigLayer,
} from "../../../providers/paths/rig-paths";
import { RigConfigRepositoryService, rigConfigRepositoryLayer } from "../repo/config-repository";
import {
  MigrationPromptStoreService,
  migrationPromptStoreLayer,
} from "../repo/migration-prompt-store";
import { RigConfigError, type RigConfigOperation } from "../types/config-error";
import type { RigConfig } from "../types/config-schema";
import type { RigConfigMutator } from "../types/config-store";
import type { RigDirectoryMigrationResult } from "../types/directory-migration";
import { DirectoryMigrationService, directoryMigrationLayer } from "./directory-migration";

export class RigConfigStoreService extends Context.Service<
  RigConfigStoreService,
  {
    readonly migrationResult: Effect.Effect<RigDirectoryMigrationResult | undefined>;
    readonly acknowledgeMigrationPrompt: Effect.Effect<void, RigConfigError>;
    readonly ensure: Effect.Effect<RigConfig, RigConfigError>;
    readonly read: Effect.Effect<RigConfig, RigConfigError>;
    readonly write: (config: RigConfig) => Effect.Effect<void, RigConfigError>;
    readonly update: (mutator: RigConfigMutator) => Effect.Effect<RigConfig, RigConfigError>;
  }
>()("@rendotdev/rig/settings/RigConfigStoreService", {
  make: Effect.gen(function* () {
    const repository = yield* RigConfigRepositoryService;
    const migrations = yield* DirectoryMigrationService;
    const prompts = yield* MigrationPromptStoreService;
    let migration: RigDirectoryMigrationResult | undefined;
    const mapError = (operation: RigConfigOperation) => (cause: unknown) =>
      cause instanceof RigConfigError ? cause : new RigConfigError({ operation, cause });
    const migrationResult = Effect.sync(() => migration).pipe(
      Effect.withSpan("RigConfigStoreService.migrationResult"),
    );
    const acknowledgeMigrationPrompt = Effect.gen(function* () {
      if (migration?.status === "manual") yield* prompts.markPrompted(migration.promptId);
    }).pipe(
      Effect.mapError(mapError("acknowledgeMigration")),
      Effect.withSpan("RigConfigStoreService.acknowledgeMigrationPrompt"),
    );
    const ensure = Effect.gen(function* () {
      migration = yield* migrations.migrateIfNeeded;
      return yield* repository.initialize;
    }).pipe(Effect.mapError(mapError("ensure")), Effect.withSpan("RigConfigStoreService.ensure"));
    const read = repository.read.pipe(Effect.withSpan("RigConfigStoreService.read"));
    const write = Effect.fn("RigConfigStoreService.write")(function* (config: RigConfig) {
      yield* repository.write(config);
    });
    const update = Effect.fn("RigConfigStoreService.update")(function* (mutator: RigConfigMutator) {
      return yield* repository.update(mutator);
    });
    return { migrationResult, acknowledgeMigrationPrompt, ensure, read, write, update } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigConfigStoreService, RigConfigStoreService.make);
}

const rigConfigStoreDependenciesLayer = Layer.mergeAll(
  rigConfigRepositoryLayer,
  directoryMigrationLayer,
  migrationPromptStoreLayer,
).pipe(Layer.provideMerge(rigPathsConfigLayer));

export const rigConfigStoreLayer: Layer.Layer<
  RigConfigStoreService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = RigConfigStoreService.layer.pipe(Layer.provide(rigConfigStoreDependenciesLayer));
