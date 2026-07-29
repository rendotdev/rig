import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type {
  LoadedTool,
  RigCacheKey,
  RigCacheQueryOptions,
  RigToolCache,
  RigToolLogger,
} from "../types/tool-types";
import {
  type DatabaseConstructor,
  SqlitePlatformService,
} from "../../../providers/database/sqlite";

type CacheIdentity = { hash: string; json: string };
type CacheEntry<Value> = { data: Value; updatedAt: number; invalidatedAt: number | null };
type CacheRow = {
  key_json: string;
  value_json: string;
  data_updated_at: number;
  invalidated_at: number | null;
};
type CacheStorage = {
  readonly read: <Value>(identity: CacheIdentity) => CacheEntry<Value> | undefined;
  readonly write: (identity: CacheIdentity, value: unknown) => void;
  readonly invalidate: (identity: CacheIdentity) => void;
  readonly remove: (identity: CacheIdentity) => void;
  readonly clear: () => void;
  readonly close: () => void;
};
type CacheDatabaseResource = {
  readonly get: () => Database;
  readonly close: () => void;
};

export type ManagedRigToolCache = RigToolCache & { close(): void };

class ToolCacheDatabaseService extends Context.Service<
  ToolCacheDatabaseService,
  {
    readonly create: (path: string, database: CacheDatabaseResource) => Effect.Effect<CacheStorage>;
  }
>()("@rendotdev/rig/persistence/ToolCacheDatabaseService", {
  make: Effect.gen(function* () {
    const create = Effect.fn("ToolCacheDatabaseService.create")(function* (
      path: string,
      database: CacheDatabaseResource,
    ) {
      const read = <Value>(identity: CacheIdentity) => {
        const row = database
          .get()
          .query(
            "select key_json, value_json, data_updated_at, invalidated_at from _rig_cache where key_hash = ?",
          )
          .get(identity.hash) as CacheRow | null;
        if (!row) return undefined;
        if (row.key_json !== identity.json) {
          throw new RigError({
            code: "TOOL_INVALID",
            message: "context.cache detected a query key hash collision.",
            details: { path },
          });
        }
        database
          .get()
          .query(
            "update _rig_cache set last_accessed_at = $lastAccessedAt where key_hash = $keyHash",
          )
          .run({ keyHash: identity.hash, lastAccessedAt: Date.now() });
        return {
          data: JSON.parse(row.value_json) as Value,
          updatedAt: row.data_updated_at,
          invalidatedAt: row.invalidated_at,
        };
      };
      const write = (identity: CacheIdentity, value: unknown) => {
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
          throw new RigError({ code: "INPUT_ERROR", message: "Cache cannot store undefined." });
        }
        const time = Date.now();
        database
          .get()
          .query(
            `insert into _rig_cache
             (key_hash, key_json, value_json, data_updated_at, invalidated_at, last_accessed_at)
             values ($keyHash, $keyJson, $valueJson, $dataUpdatedAt, null, $lastAccessedAt)
             on conflict(key_hash) do update set key_json = excluded.key_json,
             value_json = excluded.value_json, data_updated_at = excluded.data_updated_at,
             invalidated_at = null, last_accessed_at = excluded.last_accessed_at`,
          )
          .run({
            keyHash: identity.hash,
            keyJson: identity.json,
            valueJson,
            dataUpdatedAt: time,
            lastAccessedAt: time,
          });
      };
      const invalidate = (identity: CacheIdentity) =>
        void database
          .get()
          .query("update _rig_cache set invalidated_at = $invalidatedAt where key_hash = $keyHash")
          .run({ keyHash: identity.hash, invalidatedAt: Date.now() });
      const remove = (identity: CacheIdentity) =>
        void database.get().query("delete from _rig_cache where key_hash = ?").run(identity.hash);
      const clear = () => database.get().run("delete from _rig_cache");
      return { read, write, invalidate, remove, clear, close: database.close } as const;
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCacheDatabaseService, ToolCacheDatabaseService.make);
}

class ToolCacheStorageService extends Context.Service<
  ToolCacheStorageService,
  {
    readonly open: (
      path: string,
      Database: DatabaseConstructor,
    ) => Effect.Effect<CacheDatabaseResource>;
  }
>()("@rendotdev/rig/persistence/ToolCacheStorageService", {
  make: Effect.gen(function* () {
    const open = Effect.fn("ToolCacheStorageService.open")(function* (
      path: string,
      Database: DatabaseConstructor,
    ) {
      let database: Database | undefined;
      const get = (): Database => {
        if (database) return database;
        mkdirSync(dirname(path), { recursive: true });
        const opened = new Database(path, { create: true, strict: true });
        try {
          opened.run("PRAGMA journal_mode = WAL;");
          opened.run(`create table if not exists _rig_cache (
            key_hash text primary key, key_json text not null, value_json text not null,
            data_updated_at integer not null, invalidated_at integer,
            last_accessed_at integer not null
          );`);
          database = opened;
          return database;
        } catch (error) {
          opened.close(false);
          throw error;
        }
      };
      const close = () => database?.close(false);
      return { get, close } as const;
    });
    return { open } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCacheStorageService, ToolCacheStorageService.make);
}

class ToolCacheHandleService extends Context.Service<
  ToolCacheHandleService,
  {
    readonly create: (params: {
      path: string;
      storage: CacheStorage;
      identity: (queryKey: RigCacheKey) => CacheIdentity;
      staleTime: (value: number | undefined) => number;
    }) => Effect.Effect<ManagedRigToolCache>;
    readonly unavailable: (path: string) => Effect.Effect<ManagedRigToolCache>;
  }
>()("@rendotdev/rig/persistence/ToolCacheHandleService", {
  make: Effect.gen(function* () {
    const create = Effect.fn("ToolCacheHandleService.create")(function* (params: {
      path: string;
      storage: CacheStorage;
      identity: (queryKey: RigCacheKey) => CacheIdentity;
      staleTime: (value: number | undefined) => number;
    }) {
      const inFlight = new Map<string, Promise<unknown>>();
      const refresh = <Value>(key: CacheIdentity, query: () => Value | Promise<Value>) => {
        const existing = inFlight.get(key.hash);
        if (existing) return existing as Promise<Value>;
        const promise = Promise.resolve(query()).then((value) => {
          params.storage.write(key, value);
          return value;
        });
        inFlight.set(key.hash, promise);
        void promise.then(
          () => inFlight.delete(key.hash),
          () => inFlight.delete(key.hash),
        );
        return promise;
      };
      const query = async <Value>(options: RigCacheQueryOptions<Value>) => {
        const key = params.identity(options.queryKey);
        const freshnessWindow = params.staleTime(options.staleTime);
        const entry = params.storage.read<Value>(key);
        if (!entry) return await refresh(key, options.queryFn);
        const fresh =
          entry.invalidatedAt === null && Date.now() - entry.updatedAt < freshnessWindow;
        return fresh ? entry.data : await refresh(key, options.queryFn);
      };
      return {
        path: params.path,
        query,
        peek: <Value = unknown>(key: RigCacheKey) =>
          params.storage.read<Value>(params.identity(key))?.data,
        set: <Value>(key: RigCacheKey, value: Value) =>
          params.storage.write(params.identity(key), value),
        invalidate: (key: RigCacheKey) => params.storage.invalidate(params.identity(key)),
        remove: (key: RigCacheKey) => params.storage.remove(params.identity(key)),
        clear: params.storage.clear,
        close: params.storage.close,
      };
    });
    const unavailable = Effect.fn("ToolCacheHandleService.unavailable")(function* (path: string) {
      const fail = (): never => {
        throw new RigError({
          code: "TOOL_INVALID",
          message: "context.cache requires the Bun SQLite runtime.",
          details: { path },
        });
      };
      return {
        path,
        query: fail,
        peek: fail,
        set: fail,
        invalidate: fail,
        remove: fail,
        clear: fail,
        close: () => undefined,
      };
    });
    return { create, unavailable } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCacheHandleService, ToolCacheHandleService.make);
}

class ToolCacheResourceService extends Context.Service<
  ToolCacheResourceService,
  {
    readonly open: (
      path: string,
      Database: DatabaseConstructor | undefined,
    ) => Effect.Effect<ManagedRigToolCache>;
  }
>()("@rendotdev/rig/persistence/ToolCacheResourceService", {
  make: Effect.gen(function* () {
    const storageService = yield* ToolCacheStorageService;
    const databaseService = yield* ToolCacheDatabaseService;
    const handles = yield* ToolCacheHandleService;
    const invalidKeyMessage = "context.cache query keys must contain only JSON-compatible values.";
    const invalidKey = () => new RigError({ code: "INPUT_ERROR", message: invalidKeyMessage });
    const normalizeKey = (value: unknown, parents: Set<object>, inArray: boolean): unknown => {
      const isPrimitiveCacheValue =
        value === null || typeof value === "string" || typeof value === "boolean";
      if (isPrimitiveCacheValue) return value;
      if (typeof value === "number") {
        if (Number.isFinite(value)) return value;
        throw invalidKey();
      }
      if (typeof value !== "object") {
        const isOmittableUndefined = value === undefined && !inArray;
        if (isOmittableUndefined) return undefined;
        throw invalidKey();
      }
      if (parents.has(value)) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Cache query keys cannot contain cycles.",
        });
      }
      parents.add(value);
      try {
        if (Array.isArray(value)) return value.map((item) => normalizeKey(item, parents, true));
        const prototype = Object.getPrototypeOf(value);
        const hasUnsupportedPrototype = prototype !== Object.prototype && prototype !== null;
        if (hasUnsupportedPrototype) throw invalidKey();
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(value).toSorted()) {
          const item = normalizeKey((value as Record<string, unknown>)[key], parents, false);
          if (item !== undefined) normalized[key] = item;
        }
        return normalized;
      } finally {
        parents.delete(value);
      }
    };
    const identity = (queryKey: RigCacheKey): CacheIdentity => {
      const isInvalidQueryKey = !Array.isArray(queryKey) || queryKey.length === 0;
      if (isInvalidQueryKey) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Cache query keys must be non-empty arrays.",
        });
      }
      const json = JSON.stringify(normalizeKey(queryKey, new Set<object>(), true));
      return { hash: createHash("sha256").update(json).digest("hex"), json };
    };
    const staleTime = (value: number | undefined): number => {
      const normalized = value ?? 0;
      const isInvalidStaleTime =
        typeof normalized !== "number" || Number.isNaN(normalized) || normalized < 0;
      if (isInvalidStaleTime) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Cache staleTime must be a non-negative number.",
        });
      }
      return normalized;
    };
    const open = Effect.fn("ToolCacheResourceService.open")(function* (
      path: string,
      Database: DatabaseConstructor | undefined,
    ) {
      if (!Database) return yield* handles.unavailable(path);
      const database = yield* storageService.open(path, Database);
      const storage = yield* databaseService.create(path, database);
      return yield* handles.create({
        path,
        storage,
        identity,
        staleTime,
      });
    });
    return { open } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCacheResourceService, ToolCacheResourceService.make);
}

export class ToolCacheService extends Context.Service<
  ToolCacheService,
  {
    readonly pathForToolPath: (toolPath: string) => Effect.Effect<string>;
    readonly acquire: (
      tool: LoadedTool,
      log: RigToolLogger,
    ) => Effect.Effect<ManagedRigToolCache, RigError, Scope.Scope>;
  }
>()("@rendotdev/rig/persistence/ToolCacheService", {
  make: Effect.gen(function* () {
    const databases = yield* SqlitePlatformService;
    const resources = yield* ToolCacheResourceService;
    const pathForToolPath = Effect.fn("ToolCacheService.pathForToolPath")(function* (
      toolPath: string,
    ) {
      return join(dirname(toolPath), "cache.sqlite");
    });
    const acquire = Effect.fn("ToolCacheService.acquire")(function* (
      tool: LoadedTool,
      log: RigToolLogger,
    ) {
      void log;
      const path = yield* pathForToolPath(tool.path);
      const Database = (yield* databases.available) ? yield* databases.load : undefined;
      return yield* Effect.acquireRelease(resources.open(path, Database), (resource) =>
        Effect.sync(resource.close),
      );
    });
    return { pathForToolPath, acquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCacheService, ToolCacheService.make);
}

const toolCacheResourceLayer = ToolCacheResourceService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ToolCacheStorageService.layer,
      ToolCacheDatabaseService.layer,
      ToolCacheHandleService.layer,
    ),
  ),
);
export const toolCacheLayer = ToolCacheService.layer.pipe(
  Layer.provide(Layer.merge(SqlitePlatformService.layer, toolCacheResourceLayer)),
);
