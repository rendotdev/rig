import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  RigPathsConfigService,
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  RigPathsService,
  rigPathsConfigLayer,
  rigPathsLayer,
} from "../../../providers/paths/rig-paths";
import { DirectoryMigrationError } from "../types/directory-migration";

export class DirectoryMigrationInspectionService extends Context.Service<
  DirectoryMigrationInspectionService,
  {
    readonly directoryExists: (path: string) => Effect.Effect<boolean>;
    readonly visibleEntries: (path: string) => Effect.Effect<string[], DirectoryMigrationError>;
    readonly hasDefaultConfig: Effect.Effect<boolean>;
  }
>()("@rendotdev/rig/settings/DirectoryMigrationInspectionService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const attempt = <Value>(run: () => Promise<Value>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new DirectoryMigrationError({ operation: "migrate", cause }),
      });
    const directoryExists = Effect.fn("DirectoryMigrationInspectionService.directoryExists")(
      function* (path: string) {
        return yield* Effect.promise(async () => {
          try {
            return (await stat(path)).isDirectory();
          } catch {
            return false;
          }
        });
      },
    );
    const visibleEntries = Effect.fn("DirectoryMigrationInspectionService.visibleEntries")(
      function* (path: string) {
        return (yield* attempt(() => readdir(path))).filter((entry) => entry !== ".DS_Store");
      },
    );
    const hasDefaultConfig = Effect.promise(async () => {
      try {
        const parsed = JSON.parse(await readFile(paths.configPath, "utf8")) as Record<
          string,
          unknown
        >;
        return (
          parsed.version === 1 &&
          parsed.baseRegistryDir === paths.defaultBaseRegistryDir &&
          Array.isArray(parsed.customRegistries) &&
          parsed.customRegistries.length === 0 &&
          (parsed.cronJobs === undefined ||
            (Array.isArray(parsed.cronJobs) && parsed.cronJobs.length === 0))
        );
      } catch {
        return false;
      }
    }).pipe(Effect.withSpan("DirectoryMigrationInspectionService.hasDefaultConfig"));
    return { directoryExists, visibleEntries, hasDefaultConfig } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    DirectoryMigrationInspectionService,
    DirectoryMigrationInspectionService.make,
  );
}

export class DirectoryMigrationRepositoryService extends Context.Service<
  DirectoryMigrationRepositoryService,
  {
    readonly hasLegacyState: Effect.Effect<boolean>;
    readonly currentExists: Effect.Effect<boolean>;
    readonly migrate: Effect.Effect<boolean, DirectoryMigrationError>;
  }
>()("@rendotdev/rig/settings/DirectoryMigrationRepositoryService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const pathOperations = yield* RigPathsService;
    const isLegacyBaseRegistry = Effect.fn(
      "DirectoryMigrationRepositoryService.isLegacyBaseRegistry",
    )(function* (value: unknown) {
      return (
        typeof value === "string" &&
        (value === paths.legacyDefaultBaseRegistryDir ||
          (yield* pathOperations.resolve(value)) === join(paths.legacyRigDir, "tools"))
      );
    });
    const rewriteMigratedConfig = Effect.fn(
      "DirectoryMigrationRepositoryService.rewriteMigratedConfig",
    )(function* () {
      if (!existsSync(paths.configPath)) return false;
      const parsed = yield* Effect.tryPromise({
        try: async () =>
          JSON.parse(await readFile(paths.configPath, "utf8")) as Record<string, unknown>,
        catch: (cause) => new DirectoryMigrationError({ operation: "migrate", cause }),
      });
      if (!(yield* isLegacyBaseRegistry(parsed.baseRegistryDir))) return false;
      parsed.baseRegistryDir = paths.defaultBaseRegistryDir;
      yield* Effect.tryPromise({
        try: () => writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8"),
        catch: (cause) => new DirectoryMigrationError({ operation: "migrate", cause }),
      });
      return true;
    });
    const hasLegacyState = Effect.sync(
      () =>
        existsSync(paths.legacyRigDir) &&
        (existsSync(join(paths.legacyRigDir, "rig.json")) ||
          existsSync(join(paths.legacyRigDir, "tools"))),
    ).pipe(Effect.withSpan("DirectoryMigrationRepositoryService.hasLegacyState"));
    const currentExists = Effect.sync(() => existsSync(paths.rigDir)).pipe(
      Effect.withSpan("DirectoryMigrationRepositoryService.currentExists"),
    );
    const migrate = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          if (existsSync(paths.rigDir)) await rm(paths.rigDir, { recursive: true, force: true });
          await mkdir(paths.homeDir, { recursive: true });
          await rename(paths.legacyRigDir, paths.rigDir);
        },
        catch: (cause) => new DirectoryMigrationError({ operation: "migrate", cause }),
      });
      return yield* rewriteMigratedConfig();
    }).pipe(Effect.withSpan("DirectoryMigrationRepositoryService.migrate"));
    return { hasLegacyState, currentExists, migrate } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    DirectoryMigrationRepositoryService,
    DirectoryMigrationRepositoryService.make,
  );
}

export const directoryMigrationRepositoryLayer: Layer.Layer<
  DirectoryMigrationRepositoryService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = DirectoryMigrationRepositoryService.layer.pipe(
  Layer.provide(Layer.merge(rigPathsConfigLayer, rigPathsLayer)),
);
