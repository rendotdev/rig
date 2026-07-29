import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { SqlitePlatformService } from "../../../providers/database/sqlite";
import { RigError } from "../../../providers/errors/rig-error";
import type { LoadedTool, RigToolDatabase } from "../types/tool-types";

type MigrationRow = { name: string; checksum: string };

type DatabaseMigrator = {
  readonly ensureMetadata: () => void;
  readonly migrate: (version: number, name: string, sql: string) => void;
};

class DatabaseMigrationService extends Context.Service<
  DatabaseMigrationService,
  {
    readonly create: (database: Database, nowIso: () => string) => Effect.Effect<DatabaseMigrator>;
  }
>()("@rendotdev/rig/persistence/DatabaseMigrationService", {
  make: Effect.gen(function* () {
    const checksum = (version: number, name: string, sql: string) =>
      createHash("sha256").update(`${version}\0${name}\0${sql}`).digest("hex");
    const create = Effect.fn("DatabaseMigrationService.create")(function* (
      database: Database,
      nowIso: () => string,
    ) {
      let lastVersion = 0;
      const ensureMetadata = () => {
        database.run(`
          create table if not exists _rig_migrations (
            version integer primary key,
            name text not null,
            checksum text not null,
            applied_at text not null
          );
        `);
      };
      const migrate = (version: number, name: string, sql: string) => {
        const isInvalidVersion = !Number.isInteger(version) || version <= 0;
        if (isInvalidVersion) {
          throw new RigError({
            code: "TOOL_INVALID",
            message: `Migration version must be a positive integer: ${version}`,
          });
        }
        if (version <= lastVersion) {
          throw new RigError({
            code: "TOOL_INVALID",
            message: `Migration versions must be declared in ascending order: ${version} after ${lastVersion}`,
          });
        }
        const hasMissingContent = !name.trim() || !sql.trim();
        if (hasMissingContent) {
          throw new RigError({
            code: "TOOL_INVALID",
            message: !name.trim()
              ? "Migration name must not be empty."
              : `Migration ${version} SQL must not be empty.`,
          });
        }
        lastVersion = version;
        const actual = { name, checksum: checksum(version, name, sql) };
        const existing = database
          .query("select name, checksum from _rig_migrations where version = ?")
          .get(version) as MigrationRow | null;
        if (existing) {
          const isUnchangedMigration =
            existing.name === actual.name && existing.checksum === actual.checksum;
          if (isUnchangedMigration) return;
          throw new RigError({
            code: "TOOL_INVALID",
            message: `Migration ${version} has changed since it was applied.`,
            details: { version, expected: existing, actual },
          });
        }
        database.transaction(() => {
          database.run(sql);
          database
            .query(
              `insert into _rig_migrations (version, name, checksum, applied_at)
               values ($version, $name, $checksum, $appliedAt)`,
            )
            .run({ version, name, checksum: actual.checksum, appliedAt: nowIso() });
        })();
      };
      return { ensureMetadata, migrate } as const;
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(DatabaseMigrationService, DatabaseMigrationService.make);
}

export class ToolDatabaseService extends Context.Service<
  ToolDatabaseService,
  {
    readonly pathForToolPath: (toolPath: string) => Effect.Effect<string>;
    readonly acquire: (
      tool: LoadedTool,
    ) => Effect.Effect<RigToolDatabase | undefined, RigError, Scope.Scope>;
    readonly unavailable: (toolName: string) => Effect.Effect<RigToolDatabase>;
  }
>()("@rendotdev/rig/persistence/ToolDatabaseService", {
  make: Effect.gen(function* () {
    const sqlite = yield* SqlitePlatformService;
    const migrations = yield* DatabaseMigrationService;
    const toRigError = (error: unknown) => {
      if (error instanceof RigError) return error;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    };
    const pathForToolPath = Effect.fn("ToolDatabaseService.pathForToolPath")(function* (
      toolPath: string,
    ) {
      return join(dirname(toolPath), "index.sqlite");
    });
    const acquire = Effect.fn("ToolDatabaseService.acquire")(function* (tool: LoadedTool) {
      if (!tool.definition.setupDb) return undefined;
      const databasePath = yield* pathForToolPath(tool.path);
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(databasePath), { recursive: true }),
        catch: toRigError,
      });
      const Database = yield* sqlite.load;
      const database = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Database(databasePath, { create: true, strict: true }) as RigToolDatabase,
          catch: toRigError,
        }),
        (resource) => Effect.sync(() => resource.close(false)).pipe(Effect.ignore),
      );
      const migrator = yield* migrations.create(database, () => new Date().toISOString());
      yield* Effect.tryPromise({
        try: async () => {
          Object.defineProperty(database, "path", { value: databasePath, enumerable: true });
          Object.defineProperty(database, "migrate", {
            value: (version: number, name: string, sql: string) =>
              migrator.migrate(version, name, sql),
            enumerable: true,
          });
          database.run("PRAGMA journal_mode = WAL;");
          migrator.ensureMetadata();
          await tool.definition.setupDb?.(database);
        },
        catch: toRigError,
      });
      return database;
    });
    const unavailable = Effect.fn("ToolDatabaseService.unavailable")(function* (toolName: string) {
      return new Proxy({} as RigToolDatabase, {
        get: () => {
          throw new RigError({
            code: "TOOL_INVALID",
            message: `Tool ${toolName} must define setupDb before using context.db.`,
            details: { tool: toolName },
          });
        },
      });
    });
    return { pathForToolPath, acquire, unavailable } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolDatabaseService, ToolDatabaseService.make);
}

export const toolDatabaseLayer = ToolDatabaseService.layer.pipe(
  Layer.provide(Layer.merge(SqlitePlatformService.layer, DatabaseMigrationService.layer)),
);
