import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RigErrorClass } from "../../errors/RigError";
import { BunSqliteModuleLoaderClass, type DatabaseConstructor } from "../sqlite/tool-database";
import type { LoadedTool, RigToolKvStore } from "../../tools/types";

type KvRow = {
  value_json: string;
};

class SqliteToolKvStoreClass implements RigToolKvStore {
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
      throw new RigErrorClass("INPUT_ERROR", "context.kv cannot store undefined values.", { key });
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
      throw new RigErrorClass("INPUT_ERROR", "context.kv keys must be non-empty strings.", { key });
    }
  }
}

export type ManagedRigToolKvStore = RigToolKvStore & {
  close(): void;
};

class LazyToolKvStoreClass implements ManagedRigToolKvStore {
  private store?: RigToolKvStore;

  constructor(
    readonly path: string,
    private readonly create: () => RigToolKvStore,
  ) {}

  get<T = unknown>(key: string): T | undefined {
    return this.resource().get<T>(key);
  }

  set(key: string, value: unknown): void {
    this.resource().set(key, value);
  }

  close(): void {
    const store = this.store as { close?: (throwOnError?: boolean) => void } | undefined;
    if (!store) return;
    store.close?.(false);
  }

  private resource(): RigToolKvStore {
    if (this.store) return this.store;
    const store = this.create();
    this.store = store;
    return store;
  }
}

class UnavailableToolKvStoreClass implements RigToolKvStore {
  constructor(readonly path: string) {}

  get(): never {
    throw this.error();
  }

  set(): never {
    throw this.error();
  }

  private error(): RigErrorClass {
    return new RigErrorClass(
      "TOOL_INVALID",
      "context.kv requires the Bun SQLite runtime. Run rig through its normal Bun bootstrap.",
      { path: this.path },
    );
  }
}

class RigToolKvStoreFactoryClass {
  private readonly sqlite = new BunSqliteModuleLoaderClass();

  async create(toolPath: string): Promise<ManagedRigToolKvStore> {
    const kvPath = this.kvPathForToolPath(toolPath);
    const Database = this.sqlite.available() ? await this.sqlite.database() : undefined;
    return new LazyToolKvStoreClass(kvPath, () => this.open(kvPath, Database));
  }

  private open(kvPath: string, Database: DatabaseConstructor | undefined): RigToolKvStore {
    if (!Database) return new UnavailableToolKvStoreClass(kvPath);

    mkdirSync(dirname(kvPath), { recursive: true });
    const db = new Database(kvPath, { create: true, strict: true });
    try {
      db.run("PRAGMA journal_mode = WAL;");
      db.run(`
        create table if not exists _rig_kv (
          key text primary key,
          value_json text not null,
          updated_at text not null
        );
      `);
      return new SqliteToolKvStoreClass(db, kvPath);
    } catch (error) {
      db.close(false);
      throw error;
    }
  }

  kvPathForToolPath(toolPath: string): string {
    return join(dirname(toolPath), "kv.sqlite");
  }
}

export class ToolKvStoreServiceClass {
  private readonly factory = new RigToolKvStoreFactoryClass();

  async setup(tool: LoadedTool): Promise<ManagedRigToolKvStore> {
    return this.factory.create(tool.path);
  }

  kvPathForToolPath(toolPath: string): string {
    return this.factory.kvPathForToolPath(toolPath);
  }
}
