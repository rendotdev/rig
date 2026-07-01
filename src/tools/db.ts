import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigError } from "../errors/RigError";
import type { LoadedTool, RigToolDatabase } from "./types";

type MigrationRow = {
  name: string;
  checksum: string;
};

class MigrationChecksum {
  digest(version: number, name: string, sql: string): string {
    return createHash("sha256").update(`${version}\0${name}\0${sql}`).digest("hex");
  }
}

class RigDatabaseMigrator {
  private lastVersion = 0;
  private readonly checksums = new MigrationChecksum();

  constructor(private readonly db: Database) {}

  ensureMetadata(): void {
    this.db.run(`
      create table if not exists _rig_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        applied_at text not null
      );
    `);
  }

  migrate(version: number, name: string, sql: string): void {
    this.validate(version, name, sql);
    const checksum = this.checksums.digest(version, name, sql);
    const existing = this.existingMigration(version);

    if (existing) {
      this.assertExistingMigrationMatches(version, name, checksum, existing);
      return;
    }

    const apply = this.db.transaction(() => {
      this.db.run(sql);
      this.db
        .query(
          `insert into _rig_migrations (version, name, checksum, applied_at)
           values ($version, $name, $checksum, $appliedAt)`,
        )
        .run({ version, name, checksum, appliedAt: new Date().toISOString() });
    });
    apply();
  }

  private validate(version: number, name: string, sql: string): void {
    if (!Number.isInteger(version) || version <= 0) {
      throw new RigError(
        "TOOL_INVALID",
        `Migration version must be a positive integer: ${version}`,
      );
    }
    if (version <= this.lastVersion) {
      throw new RigError(
        "TOOL_INVALID",
        `Migration versions must be declared in ascending order: ${version} after ${this.lastVersion}`,
      );
    }
    if (!name.trim()) throw new RigError("TOOL_INVALID", "Migration name must not be empty.");
    if (!sql.trim())
      throw new RigError("TOOL_INVALID", `Migration ${version} SQL must not be empty.`);
    this.lastVersion = version;
  }

  private existingMigration(version: number): MigrationRow | undefined {
    const row = this.db
      .query("select name, checksum from _rig_migrations where version = ?")
      .get(version) as MigrationRow | null;
    return row ?? undefined;
  }

  private assertExistingMigrationMatches(
    version: number,
    name: string,
    checksum: string,
    existing: MigrationRow,
  ): void {
    if (existing.name === name && existing.checksum === checksum) return;
    throw new RigError("TOOL_INVALID", `Migration ${version} has changed since it was applied.`, {
      version,
      expected: existing,
      actual: { name, checksum },
    });
  }
}

type DatabaseConstructor = new (
  filename: string,
  options?: { create?: boolean; strict?: boolean },
) => Database;

class BunSqliteModuleLoader {
  async database(): Promise<DatabaseConstructor> {
    const database = (
      globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: DatabaseConstructor }
    ).rigSqliteDatabaseForTests;
    /* v8 ignore next */
    if (!database) return this.nativeDatabase();
    return database;
  }

  /* v8 ignore start */
  private async nativeDatabase(): Promise<DatabaseConstructor> {
    const specifier = "bun:sqlite";
    const moduleValue = (await import(specifier)) as { Database: DatabaseConstructor };
    return moduleValue.Database;
  }
  /* v8 ignore stop */
}

class RigToolDatabaseFactory {
  private readonly sqlite = new BunSqliteModuleLoader();

  async create(toolPath: string): Promise<RigToolDatabase> {
    const dbPath = this.dbPathForToolPath(toolPath);
    await mkdir(dirname(dbPath), { recursive: true });
    const Database = await this.sqlite.database();
    const db = new Database(dbPath, { create: true, strict: true }) as RigToolDatabase;
    const migrator = new RigDatabaseMigrator(db);

    Object.defineProperty(db, "path", { value: dbPath, enumerable: true });
    Object.defineProperty(db, "migrate", {
      value: (version: number, name: string, sql: string) => migrator.migrate(version, name, sql),
      enumerable: true,
    });

    db.run("PRAGMA journal_mode = WAL;");
    migrator.ensureMetadata();
    return db;
  }

  dbPathForToolPath(toolPath: string): string {
    return join(dirname(toolPath), "index.sqlite");
  }
}

export class UnavailableToolDatabaseFactory {
  create(toolName: string): RigToolDatabase {
    return new Proxy({} as RigToolDatabase, {
      get() {
        throw new RigError(
          "TOOL_INVALID",
          `Tool ${toolName} must define setupDb before using context.db.`,
          {
            tool: toolName,
          },
        );
      },
    });
  }
}

export class ToolDatabaseService {
  private readonly factory = new RigToolDatabaseFactory();

  async setup(tool: LoadedTool): Promise<RigToolDatabase | undefined> {
    if (!tool.definition.setupDb) return undefined;
    const db = await this.factory.create(tool.path);
    await tool.definition.setupDb(db);
    return db;
  }

  dbPathForToolPath(toolPath: string): string {
    return this.factory.dbPathForToolPath(toolPath);
  }
}
