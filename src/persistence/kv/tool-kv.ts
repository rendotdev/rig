import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineRepo, defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import type { LoadedTool, RigToolKvStore } from "../../tools/types";
import { BunSqliteModuleLoaderClass, type DatabaseConstructor } from "../sqlite/tool-database";

type KvRow = { value_json: string };

function validateKvKey(params: { key: string }): void {
  if (typeof params.key !== "string" || params.key.length === 0) {
    throw new RigErrorClass("INPUT_ERROR", "context.kv keys must be non-empty strings.", {
      key: params.key,
    });
  }
}

export const SqliteToolKvStoreSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { db: Database; path: string; nowIso: () => string }): RigToolKvStore {
    return {
      path: params.path,
      get<T = unknown>(key: string): T | undefined {
        validateKvKey({ key });
        const row = params.db
          .query("select value_json from _rig_kv where key = ?")
          .get(key) as KvRow | null;
        if (!row) return undefined;
        return JSON.parse(row.value_json) as T;
      },
      set(key: string, value: unknown): void {
        validateKvKey({ key });
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
          throw new RigErrorClass("INPUT_ERROR", "context.kv cannot store undefined values.", {
            key,
          });
        }
        params.db
          .query(
            `insert into _rig_kv (key, value_json, updated_at)
             values ($key, $valueJson, $updatedAt)
             on conflict(key) do update set
               value_json = excluded.value_json,
               updated_at = excluded.updated_at`,
          )
          .run({ key, valueJson, updatedAt: params.nowIso() });
      },
    };
  },
});

export type ManagedRigToolKvStore = RigToolKvStore & { close(): void };

function createLazyToolKvStore(params: {
  path: string;
  create: () => RigToolKvStore;
}): ManagedRigToolKvStore {
  let store: RigToolKvStore | undefined;

  function resource(): RigToolKvStore {
    if (store) return store;
    store = params.create();
    return store;
  }

  return {
    path: params.path,
    get<T = unknown>(key: string): T | undefined {
      return resource().get<T>(key);
    },
    set(key: string, value: unknown): void {
      resource().set(key, value);
    },
    close(): void {
      const closeable = store as { close?: (throwOnError?: boolean) => void } | undefined;
      if (!closeable) return;
      closeable.close?.(false);
    },
  };
}

export const LazyToolKvStoreSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createLazyToolKvStore,
});

function createUnavailableToolKvStore(params: { path: string }): RigToolKvStore {
  function unavailable(): never {
    throw new RigErrorClass(
      "TOOL_INVALID",
      "context.kv requires the Bun SQLite runtime. Run rig through its normal Bun bootstrap.",
      { path: params.path },
    );
  }
  return { path: params.path, get: unavailable, set: unavailable };
}

export const UnavailableToolKvStoreSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createUnavailableToolKvStore,
});

type RigToolKvStoreFactoryDeps = {
  sqliteAvailable: () => boolean;
  loadDatabase: () => Promise<DatabaseConstructor>;
  mkdir: typeof mkdirSync;
  dirname: typeof dirname;
  join: typeof join;
  nowIso: () => string;
};

function createRigToolKvStoreFactoryDeps(): RigToolKvStoreFactoryDeps {
  const sqlite = new BunSqliteModuleLoaderClass();
  return {
    sqliteAvailable: sqlite.available.bind(sqlite),
    loadDatabase: sqlite.database.bind(sqlite),
    mkdir: mkdirSync,
    dirname,
    join,
    nowIso() {
      return new Date().toISOString();
    },
  };
}

const RigToolKvStoreFactoryProductionDeps = createRigToolKvStoreFactoryDeps();

export class RigToolKvStoreFactoryRepo extends defineRepo({
  params: {},
  deps: RigToolKvStoreFactoryProductionDeps,
}) {
  public kvPathForToolPath(params: { toolPath: string }): string {
    return this.deps.join(this.deps.dirname(params.toolPath), "kv.sqlite");
  }

  private open(params: {
    kvPath: string;
    Database: DatabaseConstructor | undefined;
  }): RigToolKvStore {
    if (!params.Database) {
      return UnavailableToolKvStoreSingleton.create({ path: params.kvPath });
    }

    this.deps.mkdir(this.deps.dirname(params.kvPath), { recursive: true });
    const db = new params.Database(params.kvPath, { create: true, strict: true });
    try {
      db.run("PRAGMA journal_mode = WAL;");
      db.run(`
        create table if not exists _rig_kv (
          key text primary key,
          value_json text not null,
          updated_at text not null
        );
      `);
      const store = SqliteToolKvStoreSingleton.create({
        db,
        path: params.kvPath,
        nowIso: this.deps.nowIso,
      });
      return {
        ...store,
        close() {
          db.close(false);
        },
      } as RigToolKvStore;
    } catch (error) {
      db.close(false);
      throw error;
    }
  }

  public async create(params: { toolPath: string }): Promise<ManagedRigToolKvStore> {
    const kvPath = this.kvPathForToolPath(params);
    const Database = this.deps.sqliteAvailable() ? await this.deps.loadDatabase() : undefined;
    return LazyToolKvStoreSingleton.create({
      path: kvPath,
      create: () => this.open({ kvPath, Database }),
    });
  }
}

export const RigToolKvStoreFactory = new RigToolKvStoreFactoryRepo();

type ToolKvStoreServiceDeps = {
  createStore: (params: { toolPath: string }) => Promise<ManagedRigToolKvStore>;
  kvPathForToolPath: (params: { toolPath: string }) => string;
};

const ToolKvStoreServiceProductionDeps: ToolKvStoreServiceDeps = {
  createStore(params) {
    return RigToolKvStoreFactory.create(params);
  },
  kvPathForToolPath(params) {
    return RigToolKvStoreFactory.kvPathForToolPath(params);
  },
};

export class ToolKvStoreRepo extends defineRepo({
  params: {},
  deps: ToolKvStoreServiceProductionDeps,
}) {
  public async setup(params: { tool: LoadedTool }): Promise<ManagedRigToolKvStore> {
    return await this.deps.createStore({ toolPath: params.tool.path });
  }

  public kvPathForToolPath(params: { toolPath: string }): string {
    return this.deps.kvPathForToolPath(params);
  }
}

export type ToolKvStoreServiceClass = {
  setup(tool: LoadedTool): Promise<ManagedRigToolKvStore>;
  kvPathForToolPath(toolPath: string): string;
};

type ToolKvStoreServiceConstructor = {
  new (): ToolKvStoreServiceClass;
  readonly prototype: ToolKvStoreServiceClass;
};

type ToolKvStoreServiceAdapter = ToolKvStoreServiceClass & {
  readonly resource: ToolKvStoreRepo;
};

const ToolKvStoreServiceClassAdapter = function constructToolKvStoreService(
  this: ToolKvStoreServiceAdapter,
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolKvStoreRepo(),
  });
};
Object.defineProperty(ToolKvStoreServiceClassAdapter, "name", {
  value: "ToolKvStoreServiceClass",
});
Object.defineProperties(ToolKvStoreServiceClassAdapter.prototype, {
  setup: {
    configurable: true,
    value: function setup(this: ToolKvStoreServiceAdapter, tool: LoadedTool) {
      return this.resource.setup({ tool });
    },
    writable: true,
  },
  kvPathForToolPath: {
    configurable: true,
    value: function kvPathForToolPath(this: ToolKvStoreServiceAdapter, toolPath: string) {
      return this.resource.kvPathForToolPath({ toolPath });
    },
    writable: true,
  },
});

export const ToolKvStoreServiceClass =
  ToolKvStoreServiceClassAdapter as unknown as ToolKvStoreServiceConstructor;
