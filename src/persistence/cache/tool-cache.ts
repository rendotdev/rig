import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineRepo, defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import type {
  LoadedTool,
  RigCacheKey,
  RigCacheQueryOptions,
  RigToolCache,
  RigToolLogger,
} from "../../tools/types";
import { BunSqliteModuleLoaderClass, type DatabaseConstructor } from "../sqlite/tool-database";

type CacheIdentity = { hash: string; json: string };
type CacheRow = {
  key_json: string;
  value_json: string;
  data_updated_at: number;
  invalidated_at: number | null;
};

export type ManagedRigToolCache = RigToolCache & { close(): void };

function invalidCacheKeyValue(_params: {}): RigErrorClass {
  return new RigErrorClass(
    "INPUT_ERROR",
    "context.cache query keys must contain only JSON-compatible values.",
  );
}

function normalizeCacheKey(params: {
  value: unknown;
  parents: Set<object>;
  inArray: boolean;
}): unknown {
  if (
    params.value === null ||
    typeof params.value === "string" ||
    typeof params.value === "boolean"
  ) {
    return params.value;
  }
  if (typeof params.value === "number") {
    if (Number.isFinite(params.value)) return params.value;
    throw invalidCacheKeyValue({});
  }
  if (typeof params.value !== "object") {
    if (params.value === undefined && !params.inArray) return undefined;
    throw invalidCacheKeyValue({});
  }
  if (params.parents.has(params.value)) {
    throw new RigErrorClass("INPUT_ERROR", "context.cache query keys cannot contain cycles.");
  }

  params.parents.add(params.value);
  try {
    if (Array.isArray(params.value)) {
      return params.value.map(function normalizeArrayItem(item) {
        return normalizeCacheKey({ value: item, parents: params.parents, inArray: true });
      });
    }
    const prototype = Object.getPrototypeOf(params.value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidCacheKeyValue({});
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(params.value).toSorted()) {
      const item = normalizeCacheKey({
        value: (params.value as Record<string, unknown>)[key],
        parents: params.parents,
        inArray: false,
      });
      if (item !== undefined) normalized[key] = item;
    }
    return normalized;
  } finally {
    params.parents.delete(params.value);
  }
}

function cacheKeyIdentity(params: { queryKey: RigCacheKey }): CacheIdentity {
  if (!Array.isArray(params.queryKey) || params.queryKey.length === 0) {
    throw new RigErrorClass("INPUT_ERROR", "context.cache query keys must be non-empty arrays.");
  }
  const json = JSON.stringify(
    normalizeCacheKey({ value: params.queryKey, parents: new Set<object>(), inArray: true }),
  );
  return { hash: createHash("sha256").update(json).digest("hex"), json };
}

export const CacheKeyHasherSingleton = defineSingleton({
  params: {},
  deps: {},
  identity: cacheKeyIdentity,
});

function staleTime(params: { value: number | undefined }): number {
  const value = params.value ?? 0;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RigErrorClass(
      "INPUT_ERROR",
      "context.cache staleTime must be a non-negative number.",
    );
  }
  return value;
}

function createSqliteToolCache(params: {
  db: Database;
  path: string;
  now: () => number;
}): ManagedRigToolCache {
  const inFlight = new Map<string, Promise<unknown>>();

  function read<T>(
    identity: CacheIdentity,
  ): { data: T; updatedAt: number; invalidatedAt: number | null } | undefined {
    const row = params.db
      .query(
        "select key_json, value_json, data_updated_at, invalidated_at from _rig_cache where key_hash = ?",
      )
      .get(identity.hash) as CacheRow | null;
    if (!row) return undefined;
    if (row.key_json !== identity.json) {
      throw new RigErrorClass(
        "TOOL_INVALID",
        "context.cache detected a query key hash collision.",
        {
          path: params.path,
        },
      );
    }
    params.db
      .query("update _rig_cache set last_accessed_at = $lastAccessedAt where key_hash = $keyHash")
      .run({ keyHash: identity.hash, lastAccessedAt: params.now() });
    return {
      data: JSON.parse(row.value_json) as T,
      updatedAt: row.data_updated_at,
      invalidatedAt: row.invalidated_at,
    };
  }

  function write(identity: CacheIdentity, value: unknown): void {
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) {
      throw new RigErrorClass("INPUT_ERROR", "context.cache cannot store undefined values.", {
        queryKey: identity.json,
      });
    }
    const timestamp = params.now();
    params.db
      .query(
        `insert into _rig_cache (
           key_hash, key_json, value_json, data_updated_at, invalidated_at, last_accessed_at
         ) values ($keyHash, $keyJson, $valueJson, $dataUpdatedAt, null, $lastAccessedAt)
         on conflict(key_hash) do update set
           key_json = excluded.key_json,
           value_json = excluded.value_json,
           data_updated_at = excluded.data_updated_at,
           invalidated_at = null,
           last_accessed_at = excluded.last_accessed_at`,
      )
      .run({
        keyHash: identity.hash,
        keyJson: identity.json,
        valueJson,
        dataUpdatedAt: timestamp,
        lastAccessedAt: timestamp,
      });
  }

  function refresh<T>(identity: CacheIdentity, queryFn: () => T | Promise<T>): Promise<T> {
    const existing = inFlight.get(identity.hash);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve()
      .then(queryFn)
      .then(function storeValue(value) {
        write(identity, value);
        return value;
      });
    inFlight.set(identity.hash, promise);
    void promise.then(
      function clearSuccess() {
        return inFlight.delete(identity.hash);
      },
      function clearFailure() {
        return inFlight.delete(identity.hash);
      },
    );
    return promise;
  }

  return {
    path: params.path,
    async query<T>(options: RigCacheQueryOptions<T>): Promise<T> {
      const freshness = staleTime({ value: options.staleTime });
      const identity = CacheKeyHasherSingleton.identity({ queryKey: options.queryKey });
      const entry = read<T>(identity);
      if (!entry) return await refresh(identity, options.queryFn);
      if (entry.invalidatedAt === null && params.now() - entry.updatedAt < freshness) {
        return entry.data;
      }
      return await refresh(identity, options.queryFn);
    },
    peek<T = unknown>(queryKey: RigCacheKey): T | undefined {
      return read<T>(CacheKeyHasherSingleton.identity({ queryKey }))?.data;
    },
    set<T>(queryKey: RigCacheKey, value: T): void {
      write(CacheKeyHasherSingleton.identity({ queryKey }), value);
    },
    invalidate(queryKey: RigCacheKey): void {
      const identity = CacheKeyHasherSingleton.identity({ queryKey });
      params.db
        .query("update _rig_cache set invalidated_at = $invalidatedAt where key_hash = $keyHash")
        .run({ keyHash: identity.hash, invalidatedAt: params.now() });
    },
    remove(queryKey: RigCacheKey): void {
      const identity = CacheKeyHasherSingleton.identity({ queryKey });
      params.db.query("delete from _rig_cache where key_hash = ?").run(identity.hash);
    },
    clear(): void {
      params.db.run("delete from _rig_cache");
    },
    close(): void {
      params.db.close(false);
    },
  };
}

export const SqliteToolCacheSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createSqliteToolCache,
});

function createLazyToolCache(params: {
  path: string;
  create: () => ManagedRigToolCache;
}): ManagedRigToolCache {
  let cache: ManagedRigToolCache | undefined;
  function resource(): ManagedRigToolCache {
    if (cache) return cache;
    cache = params.create();
    return cache;
  }
  return {
    path: params.path,
    query<T>(options: RigCacheQueryOptions<T>): Promise<T> {
      return resource().query(options);
    },
    peek<T = unknown>(queryKey: RigCacheKey): T | undefined {
      return resource().peek<T>(queryKey);
    },
    set<T>(queryKey: RigCacheKey, value: T): void {
      resource().set(queryKey, value);
    },
    invalidate(queryKey: RigCacheKey): void {
      resource().invalidate(queryKey);
    },
    remove(queryKey: RigCacheKey): void {
      resource().remove(queryKey);
    },
    clear(): void {
      resource().clear();
    },
    close(): void {
      cache?.close();
    },
  };
}

export const LazyToolCacheSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createLazyToolCache,
});

function createUnavailableToolCache(params: { path: string }): ManagedRigToolCache {
  function unavailable(): never {
    throw new RigErrorClass(
      "TOOL_INVALID",
      "context.cache requires the Bun SQLite runtime. Run rig through its normal Bun bootstrap.",
      { path: params.path },
    );
  }
  return {
    path: params.path,
    query: unavailable,
    peek: unavailable,
    set: unavailable,
    invalidate: unavailable,
    remove: unavailable,
    clear: unavailable,
    close() {},
  };
}

export const UnavailableToolCacheSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createUnavailableToolCache,
});

type RigToolCacheFactoryDeps = {
  sqliteAvailable: () => boolean;
  loadDatabase: () => Promise<DatabaseConstructor>;
  mkdir: typeof mkdirSync;
  dirname: typeof dirname;
  join: typeof join;
  now: () => number;
};

function createRigToolCacheFactoryDeps(): RigToolCacheFactoryDeps {
  const sqlite = new BunSqliteModuleLoaderClass();
  return {
    sqliteAvailable: sqlite.available.bind(sqlite),
    loadDatabase: sqlite.database.bind(sqlite),
    mkdir: mkdirSync,
    dirname,
    join,
    now: Date.now,
  };
}

const RigToolCacheFactoryProductionDeps = createRigToolCacheFactoryDeps();

export class RigToolCacheFactoryRepo extends defineRepo({
  params: {},
  deps: RigToolCacheFactoryProductionDeps,
}) {
  public cachePathForToolPath(params: { toolPath: string }): string {
    return this.deps.join(this.deps.dirname(params.toolPath), "cache.sqlite");
  }

  private open(params: {
    cachePath: string;
    Database: DatabaseConstructor | undefined;
  }): ManagedRigToolCache {
    if (!params.Database) {
      return UnavailableToolCacheSingleton.create({ path: params.cachePath });
    }
    this.deps.mkdir(this.deps.dirname(params.cachePath), { recursive: true });
    const db = new params.Database(params.cachePath, { create: true, strict: true });
    try {
      db.run("PRAGMA journal_mode = WAL;");
      db.run(`
        create table if not exists _rig_cache (
          key_hash text primary key,
          key_json text not null,
          value_json text not null,
          data_updated_at integer not null,
          invalidated_at integer,
          last_accessed_at integer not null
        );
      `);
      return SqliteToolCacheSingleton.create({
        db,
        path: params.cachePath,
        now: this.deps.now,
      });
    } catch (error) {
      db.close(false);
      throw error;
    }
  }

  public async create(params: {
    toolPath: string;
    log: RigToolLogger;
  }): Promise<ManagedRigToolCache> {
    void params.log;
    const cachePath = this.cachePathForToolPath(params);
    const Database = this.deps.sqliteAvailable() ? await this.deps.loadDatabase() : undefined;
    return LazyToolCacheSingleton.create({
      path: cachePath,
      create: () => this.open({ cachePath, Database }),
    });
  }
}

export const RigToolCacheFactory = new RigToolCacheFactoryRepo();

type ToolCacheServiceDeps = {
  createCache: (params: { toolPath: string; log: RigToolLogger }) => Promise<ManagedRigToolCache>;
  cachePathForToolPath: (params: { toolPath: string }) => string;
};

const ToolCacheServiceProductionDeps: ToolCacheServiceDeps = {
  createCache(params) {
    return RigToolCacheFactory.create(params);
  },
  cachePathForToolPath(params) {
    return RigToolCacheFactory.cachePathForToolPath(params);
  },
};

export class ToolCacheRepo extends defineRepo({
  params: {},
  deps: ToolCacheServiceProductionDeps,
}) {
  public async setup(params: {
    tool: LoadedTool;
    log: RigToolLogger;
  }): Promise<ManagedRigToolCache> {
    return await this.deps.createCache({ toolPath: params.tool.path, log: params.log });
  }

  public cachePathForToolPath(params: { toolPath: string }): string {
    return this.deps.cachePathForToolPath(params);
  }
}

export const ToolCache = new ToolCacheRepo();

export class ToolCacheServiceClass {
  public setup(tool: LoadedTool, log: RigToolLogger): Promise<ManagedRigToolCache> {
    return ToolCache.setup({ tool, log });
  }

  public cachePathForToolPath(toolPath: string): string {
    return ToolCache.cachePathForToolPath({ toolPath });
  }
}
