import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineProvider, defineRepo, defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import type { LoadedTool, RigToolDatabase } from "../../tools/types";

type MigrationRow = { name: string; checksum: string };

function migrationChecksum(params: { version: number; name: string; sql: string }): string {
  return createHash("sha256")
    .update(`${params.version}\0${params.name}\0${params.sql}`)
    .digest("hex");
}

export const RigDatabaseMigratorSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { db: Database; nowIso: () => string }) {
    let lastVersion = 0;

    function ensureMetadata(_params: {}): void {
      params.db.run(`
            create table if not exists _rig_migrations (
              version integer primary key,
              name text not null,
              checksum text not null,
              applied_at text not null
            );
          `);
    }

    function validate(validation: { version: number; name: string; sql: string }): void {
      if (!Number.isInteger(validation.version) || validation.version <= 0) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Migration version must be a positive integer: ${validation.version}`,
        );
      }
      if (validation.version <= lastVersion) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Migration versions must be declared in ascending order: ${validation.version} after ${lastVersion}`,
        );
      }
      if (!validation.name.trim()) {
        throw new RigErrorClass("TOOL_INVALID", "Migration name must not be empty.");
      }
      if (!validation.sql.trim()) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Migration ${validation.version} SQL must not be empty.`,
        );
      }
      lastVersion = validation.version;
    }

    function existingMigration(existing: { version: number }): MigrationRow | undefined {
      const row = params.db
        .query("select name, checksum from _rig_migrations where version = ?")
        .get(existing.version) as MigrationRow | null;
      return row ?? undefined;
    }

    function migrate(migration: { version: number; name: string; sql: string }): void {
      validate(migration);
      const checksum = migrationChecksum(migration);
      const existing = existingMigration({ version: migration.version });
      if (existing) {
        if (existing.name === migration.name && existing.checksum === checksum) return;
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Migration ${migration.version} has changed since it was applied.`,
          {
            version: migration.version,
            expected: existing,
            actual: { name: migration.name, checksum },
          },
        );
      }

      const apply = params.db.transaction(function applyMigration() {
        params.db.run(migration.sql);
        params.db
          .query(
            `insert into _rig_migrations (version, name, checksum, applied_at)
                 values ($version, $name, $checksum, $appliedAt)`,
          )
          .run({
            version: migration.version,
            name: migration.name,
            checksum,
            appliedAt: params.nowIso(),
          });
      });
      apply();
    }

    return { ensureMetadata, migrate };
  },
});

export type DatabaseConstructor = new (
  filename: string,
  options?: { create?: boolean; strict?: boolean },
) => Database;

type BunSqliteModuleLoaderDeps = {
  testDatabase: () => DatabaseConstructor | undefined;
  hasBun: () => boolean;
  nativeDatabase: () => Promise<DatabaseConstructor>;
};

const BunSqliteModuleLoaderProductionDeps: BunSqliteModuleLoaderDeps = {
  testDatabase() {
    return (globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: DatabaseConstructor })
      .rigSqliteDatabaseForTests;
  },
  hasBun() {
    return Boolean((globalThis as typeof globalThis & { Bun?: unknown }).Bun);
  },
  /* v8 ignore start */
  async nativeDatabase() {
    const moduleValue = (await import("bun:sqlite")) as { Database: DatabaseConstructor };
    return moduleValue.Database;
  },
  /* v8 ignore stop */
};

export class BunSqliteModuleLoaderProvider extends defineProvider({
  params: {},
  deps: BunSqliteModuleLoaderProductionDeps,
}) {
  public available(_params: {}): boolean {
    return Boolean(this.deps.testDatabase() || this.deps.hasBun());
  }

  public async database(_params: {}): Promise<DatabaseConstructor> {
    const testDatabase = this.deps.testDatabase();
    /* v8 ignore next */
    if (!testDatabase) return await this.deps.nativeDatabase();
    return testDatabase;
  }
}

export const BunSqliteModuleLoader = new BunSqliteModuleLoaderProvider();

export type BunSqliteModuleLoaderClass = {
  available(): boolean;
  database(): Promise<DatabaseConstructor>;
};

type BunSqliteModuleLoaderConstructor = {
  new (): BunSqliteModuleLoaderClass;
  readonly prototype: BunSqliteModuleLoaderClass;
};

type BunSqliteModuleLoaderAdapter = BunSqliteModuleLoaderClass & {
  readonly resource: BunSqliteModuleLoaderProvider;
};

const BunSqliteModuleLoaderClassAdapter = function constructBunSqliteModuleLoader(
  this: BunSqliteModuleLoaderAdapter,
): void {
  Object.defineProperty(this, "resource", { value: BunSqliteModuleLoader });
};
Object.defineProperty(BunSqliteModuleLoaderClassAdapter, "name", {
  value: "BunSqliteModuleLoaderClass",
});
Object.defineProperties(BunSqliteModuleLoaderClassAdapter.prototype, {
  available: {
    configurable: true,
    value: function available(this: BunSqliteModuleLoaderAdapter) {
      return this.resource.available({});
    },
    writable: true,
  },
  database: {
    configurable: true,
    value: function database(this: BunSqliteModuleLoaderAdapter) {
      return this.resource.database({});
    },
    writable: true,
  },
});

export const BunSqliteModuleLoaderClass =
  BunSqliteModuleLoaderClassAdapter as unknown as BunSqliteModuleLoaderConstructor;

type RigToolDatabaseFactoryDeps = {
  loadDatabase: () => Promise<DatabaseConstructor>;
  mkdir: typeof mkdir;
  dirname: typeof dirname;
  join: typeof join;
  nowIso: () => string;
};

function createRigToolDatabaseFactoryDeps(): RigToolDatabaseFactoryDeps {
  const sqlite = new BunSqliteModuleLoaderClass();
  return {
    loadDatabase: sqlite.database.bind(sqlite),
    mkdir,
    dirname,
    join,
    nowIso() {
      return new Date().toISOString();
    },
  };
}

const RigToolDatabaseFactoryProductionDeps = createRigToolDatabaseFactoryDeps();

export class RigToolDatabaseFactoryRepo extends defineRepo({
  params: {},
  deps: RigToolDatabaseFactoryProductionDeps,
}) {
  public dbPathForToolPath(params: { toolPath: string }): string {
    return this.deps.join(this.deps.dirname(params.toolPath), "index.sqlite");
  }

  public async create(params: { toolPath: string }): Promise<RigToolDatabase> {
    const dbPath = this.dbPathForToolPath(params);
    await this.deps.mkdir(this.deps.dirname(dbPath), { recursive: true });
    const Database = await this.deps.loadDatabase();
    const db = new Database(dbPath, { create: true, strict: true }) as RigToolDatabase;
    try {
      const migrator = RigDatabaseMigratorSingleton.create({
        db,
        nowIso: this.deps.nowIso,
      });
      Object.defineProperty(db, "path", { value: dbPath, enumerable: true });
      Object.defineProperty(db, "migrate", {
        value(version: number, name: string, sql: string) {
          return migrator.migrate({ version, name, sql });
        },
        enumerable: true,
      });
      db.run("PRAGMA journal_mode = WAL;");
      migrator.ensureMetadata({});
      return db;
    } catch (error) {
      db.close(false);
      throw error;
    }
  }
}

export const RigToolDatabaseFactory = new RigToolDatabaseFactoryRepo();

function unavailableDatabase(params: { toolName: string }): RigToolDatabase {
  return new Proxy({} as RigToolDatabase, {
    get() {
      throw new RigErrorClass(
        "TOOL_INVALID",
        `Tool ${params.toolName} must define setupDb before using context.db.`,
        { tool: params.toolName },
      );
    },
  });
}

export const UnavailableToolDatabaseFactorySingleton = defineSingleton({
  params: {},
  deps: {},
  create: unavailableDatabase,
});

export type UnavailableToolDatabaseFactoryClass = {
  create(toolName: string): RigToolDatabase;
};

type UnavailableToolDatabaseFactoryConstructor = {
  new (): UnavailableToolDatabaseFactoryClass;
  readonly prototype: UnavailableToolDatabaseFactoryClass;
};

const UnavailableToolDatabaseFactoryClassAdapter =
  function constructUnavailableToolDatabaseFactory(): void {};
Object.defineProperty(UnavailableToolDatabaseFactoryClassAdapter, "name", {
  value: "UnavailableToolDatabaseFactoryClass",
});
Object.defineProperty(UnavailableToolDatabaseFactoryClassAdapter.prototype, "create", {
  configurable: true,
  value: function create(toolName: string) {
    return UnavailableToolDatabaseFactorySingleton.create({ toolName });
  },
  writable: true,
});

export const UnavailableToolDatabaseFactoryClass =
  UnavailableToolDatabaseFactoryClassAdapter as unknown as UnavailableToolDatabaseFactoryConstructor;

type ToolDatabaseServiceDeps = {
  createDatabase: (params: { toolPath: string }) => Promise<RigToolDatabase>;
  dbPathForToolPath: (params: { toolPath: string }) => string;
};

const ToolDatabaseServiceProductionDeps: ToolDatabaseServiceDeps = {
  createDatabase(params) {
    return RigToolDatabaseFactory.create(params);
  },
  dbPathForToolPath(params) {
    return RigToolDatabaseFactory.dbPathForToolPath(params);
  },
};

export class ToolDatabaseRepo extends defineRepo({
  params: {},
  deps: ToolDatabaseServiceProductionDeps,
}) {
  public async setup(params: { tool: LoadedTool }): Promise<RigToolDatabase | undefined> {
    if (!params.tool.definition.setupDb) return undefined;
    const db = await this.deps.createDatabase({ toolPath: params.tool.path });
    try {
      await params.tool.definition.setupDb(db);
      return db;
    } catch (error) {
      db.close(false);
      throw error;
    }
  }

  public dbPathForToolPath(params: { toolPath: string }): string {
    return this.deps.dbPathForToolPath(params);
  }
}

export const ToolDatabase = new ToolDatabaseRepo();

export type ToolDatabaseServiceClass = {
  setup(tool: LoadedTool): Promise<RigToolDatabase | undefined>;
  dbPathForToolPath(toolPath: string): string;
};

type ToolDatabaseServiceConstructor = {
  new (): ToolDatabaseServiceClass;
  readonly prototype: ToolDatabaseServiceClass;
};

type ToolDatabaseServiceAdapter = ToolDatabaseServiceClass & {
  readonly resource: ToolDatabaseRepo;
};

const ToolDatabaseServiceClassAdapter = function constructToolDatabaseService(
  this: ToolDatabaseServiceAdapter,
): void {
  Object.defineProperty(this, "resource", { value: ToolDatabase });
};
Object.defineProperty(ToolDatabaseServiceClassAdapter, "name", {
  value: "ToolDatabaseServiceClass",
});
Object.defineProperties(ToolDatabaseServiceClassAdapter.prototype, {
  setup: {
    configurable: true,
    value: function setup(this: ToolDatabaseServiceAdapter, tool: LoadedTool) {
      return this.resource.setup({ tool });
    },
    writable: true,
  },
  dbPathForToolPath: {
    configurable: true,
    value: function dbPathForToolPath(this: ToolDatabaseServiceAdapter, toolPath: string) {
      return this.resource.dbPathForToolPath({ toolPath });
    },
    writable: true,
  },
});

export const ToolDatabaseServiceClass =
  ToolDatabaseServiceClassAdapter as unknown as ToolDatabaseServiceConstructor;
