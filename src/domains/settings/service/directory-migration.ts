import { Context, Effect, Layer } from "effect";
import {
  RigPathsConfigService,
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  RigPathsService,
  rigPathsConfigLayer,
  rigPathsLayer,
} from "../../../providers/paths/rig-paths";
import { RigHomeDirectoryMigrationPromptId } from "../config/directory-migration";
import {
  DirectoryMigrationInspectionService,
  DirectoryMigrationRepositoryService,
  directoryMigrationRepositoryLayer,
} from "../repo/directory-migration";
import {
  MigrationPromptStoreService,
  migrationPromptStoreLayer,
} from "../repo/migration-prompt-store";
import {
  DirectoryMigrationError,
  type RigDirectoryMigrationResult,
} from "../types/directory-migration";

class DirectoryMigrationCurrentStateService extends Context.Service<
  DirectoryMigrationCurrentStateService,
  {
    readonly canReplaceCurrentDirectory: Effect.Effect<boolean, DirectoryMigrationError>;
  }
>()("@rendotdev/rig/settings/DirectoryMigrationCurrentStateService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const pathOperations = yield* RigPathsService;
    const inspection = yield* DirectoryMigrationInspectionService;
    const hasEmptyRegistry = Effect.fn("DirectoryMigrationCurrentStateService.hasEmptyRegistry")(
      function* () {
        const path = yield* pathOperations.resolve(paths.defaultBaseRegistryDir);
        return (
          !(yield* inspection.directoryExists(path)) ||
          (yield* inspection.visibleEntries(path)).every((entry) => entry === "tsconfig.json")
        );
      },
    );
    const hasEmptyCron = Effect.fn("DirectoryMigrationCurrentStateService.hasEmptyCron")(
      function* () {
        return (
          !(yield* inspection.directoryExists(paths.cronDir)) ||
          (yield* inspection.visibleEntries(paths.cronDir)).length === 0
        );
      },
    );
    const hasOnlyGeneratedEntries = Effect.fn(
      "DirectoryMigrationCurrentStateService.hasOnlyGeneratedEntries",
    )(function* () {
      const generated = new Set([
        "rig.json",
        "runtime",
        "tools",
        "update-check.json",
        "cron",
        "migration-prompts.json",
      ]);
      return (yield* inspection.visibleEntries(paths.rigDir)).every((entry) =>
        generated.has(entry),
      );
    });
    const canReplaceCurrentDirectory = Effect.gen(function* () {
      return (
        (yield* inspection.hasDefaultConfig) &&
        (yield* hasEmptyRegistry()) &&
        (yield* hasEmptyCron()) &&
        (yield* hasOnlyGeneratedEntries())
      );
    }).pipe(Effect.withSpan("DirectoryMigrationCurrentStateService.canReplaceCurrentDirectory"));
    return { canReplaceCurrentDirectory } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    DirectoryMigrationCurrentStateService,
    DirectoryMigrationCurrentStateService.make,
  );
}

export class DirectoryMigrationService extends Context.Service<
  DirectoryMigrationService,
  {
    readonly migrateIfNeeded: Effect.Effect<
      RigDirectoryMigrationResult | undefined,
      DirectoryMigrationError
    >;
  }
>()("@rendotdev/rig/settings/DirectoryMigrationService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const promptStore = yield* MigrationPromptStoreService;
    const state = yield* DirectoryMigrationCurrentStateService;
    const repository = yield* DirectoryMigrationRepositoryService;
    const migrateIfNeeded = Effect.gen(function* () {
      if (!(yield* repository.hasLegacyState)) return undefined;
      const requiresManualMigration =
        (yield* repository.currentExists) && !(yield* state.canReplaceCurrentDirectory);
      if (requiresManualMigration) {
        if (yield* promptStore.hasPrompted(RigHomeDirectoryMigrationPromptId)) return undefined;
        return {
          promptId: RigHomeDirectoryMigrationPromptId,
          status: "manual" as const,
          legacyDir: paths.legacyRigDir,
          currentDir: paths.rigDir,
          configUpdated: false,
          reason: "Rig found data in both the old and new folders.",
        };
      }
      return {
        promptId: RigHomeDirectoryMigrationPromptId,
        status: "migrated" as const,
        legacyDir: paths.legacyRigDir,
        currentDir: paths.rigDir,
        configUpdated: yield* repository.migrate,
      };
    }).pipe(Effect.withSpan("DirectoryMigrationService.migrateIfNeeded"));
    return { migrateIfNeeded } as const;
  }),
}) {
  static readonly layer = Layer.effect(DirectoryMigrationService, DirectoryMigrationService.make);
}

const directoryMigrationCurrentStateLayer = DirectoryMigrationCurrentStateService.layer.pipe(
  Layer.provide(DirectoryMigrationInspectionService.layer),
);
const currentStateForMigrationLayer = directoryMigrationCurrentStateLayer.pipe(
  Layer.provide(rigPathsLayer),
);
export const directoryMigrationLayer: Layer.Layer<
  DirectoryMigrationService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = DirectoryMigrationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsConfigLayer,
      migrationPromptStoreLayer,
      currentStateForMigrationLayer,
      directoryMigrationRepositoryLayer,
    ),
  ),
);
