import type { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigError } from "../errors/RigError";
import { BunSqliteModuleLoader } from "./db";
import type { LoadedTool, RigToolKvStore } from "./types";

type KvRow = {
  value_json: string;
};

class SqliteToolKvStore implements RigToolKvStore {
  constructor(
    private readonly db: Database,
    readonly path: string,
  ) {}

  get<T = unknown>(key: string): T | undefined {
    this.validateKey(key);
    const row = this.db
      .query("select value_json from _rig_kv where key = ?")
      .get(key) as KvRow | null;
    if (!row) return undefined;
    return JSON.parse(row.value_json) as T;
  }

  set(key: string, value: unknown): void {
    this.validateKey(key);
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) {
      throw new RigError("INPUT_ERROR", "context.kv cannot store undefined values.", { key });
    }

    this.db
      .query(
        `insert into _rig_kv (key, value_json, updated_at)
         values ($key, $valueJson, $updatedAt)
         on conflict(key) do update set
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run({ key, valueJson, updatedAt: new Date().toISOString() });
  }

  close(): void {
    this.db.close(false);
  }

  private validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new RigError("INPUT_ERROR", "context.kv keys must be non-empty strings.", { key });
    }
  }
}

class UnavailableToolKvStore implements RigToolKvStore {
  constructor(readonly path: string) {}

  get(): never {
    throw this.error();
  }

  set(): never {
    throw this.error();
  }

  private error(): RigError {
    return new RigError(
      "TOOL_INVALID",
      "context.kv requires the Bun SQLite runtime. Run rig through its normal Bun bootstrap.",
      { path: this.path },
    );
  }
}

class RigToolKvStoreFactory {
  private readonly sqlite = new BunSqliteModuleLoader();

  async create(toolPath: string): Promise<RigToolKvStore> {
    const kvPath = this.kvPathForToolPath(toolPath);
    if (!this.sqlite.available()) return new UnavailableToolKvStore(kvPath);

    await mkdir(dirname(kvPath), { recursive: true });
    const Database = await this.sqlite.database();
    const db = new Database(kvPath, { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL;");
    db.run(`
      create table if not exists _rig_kv (
        key text primary key,
        value_json text not null,
        updated_at text not null
      );
    `);
    return new SqliteToolKvStore(db, kvPath);
  }

  kvPathForToolPath(toolPath: string): string {
    return join(dirname(toolPath), "kv.sqlite");
  }
}

export class ToolKvStoreService {
  private readonly factory = new RigToolKvStoreFactory();

  async setup(tool: LoadedTool): Promise<RigToolKvStore> {
    return this.factory.create(tool.path);
  }

  kvPathForToolPath(toolPath: string): string {
    return this.factory.kvPathForToolPath(toolPath);
  }
}
