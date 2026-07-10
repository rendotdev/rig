import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigError } from "../errors/RigError";
import { BunSqliteModuleLoader } from "./db";
import type {
  LoadedTool,
  RigCacheKey,
  RigCacheQueryOptions,
  RigToolCache,
  RigToolLogger,
} from "./types";

type CacheIdentity = {
  hash: string;
  json: string;
};

type CacheRow = {
  key_json: string;
  value_json: string;
  data_updated_at: number;
  invalidated_at: number | null;
};

export type ManagedRigToolCache = RigToolCache & {
  settle(): Promise<void>;
  close(): void;
};

class CacheKeyHasher {
  identity(queryKey: RigCacheKey): CacheIdentity {
    if (!Array.isArray(queryKey) || queryKey.length === 0) {
      throw new RigError("INPUT_ERROR", "context.cache query keys must be non-empty arrays.");
    }
    const json = JSON.stringify(this.normalize(queryKey, new Set<object>(), true));
    return { hash: createHash("sha256").update(json).digest("hex"), json };
  }

  private normalize(value: unknown, parents: Set<object>, inArray: boolean): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw this.invalidValue();
    }
    if (typeof value !== "object") {
      if (value === undefined && !inArray) return undefined;
      throw this.invalidValue();
    }
    if (parents.has(value)) {
      throw new RigError("INPUT_ERROR", "context.cache query keys cannot contain cycles.");
    }

    parents.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.normalize(item, parents, true));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw this.invalidValue();
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value).toSorted()) {
        const item = this.normalize((value as Record<string, unknown>)[key], parents, false);
        if (item !== undefined) normalized[key] = item;
      }
      return normalized;
    } finally {
      parents.delete(value);
    }
  }

  private invalidValue(): RigError {
    return new RigError(
      "INPUT_ERROR",
      "context.cache query keys must contain only JSON-compatible values.",
    );
  }
}

class SqliteToolCache implements ManagedRigToolCache {
  private readonly keys = new CacheKeyHasher();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Database,
    readonly path: string,
    private readonly log: RigToolLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async query<T>(options: RigCacheQueryOptions<T>): Promise<T> {
    const staleTime = this.staleTime(options.staleTime);
    const identity = this.keys.identity(options.queryKey);
    const entry = this.read<T>(identity);
    if (!entry) return this.refresh(identity, options.queryFn, false);
    if (entry.invalidatedAt === null && this.now() - entry.updatedAt < staleTime) {
      return entry.data;
    }

    void this.refresh(identity, options.queryFn, true);
    return entry.data;
  }

  peek<T = unknown>(queryKey: RigCacheKey): T | undefined {
    return this.read<T>(this.keys.identity(queryKey))?.data;
  }

  set<T>(queryKey: RigCacheKey, value: T): void {
    this.write(this.keys.identity(queryKey), value);
  }

  invalidate(queryKey: RigCacheKey): void {
    const identity = this.keys.identity(queryKey);
    this.db
      .query("update _rig_cache set invalidated_at = $invalidatedAt where key_hash = $keyHash")
      .run({ keyHash: identity.hash, invalidatedAt: this.now() });
  }

  remove(queryKey: RigCacheKey): void {
    const identity = this.keys.identity(queryKey);
    this.db.query("delete from _rig_cache where key_hash = ?").run(identity.hash);
  }

  clear(): void {
    this.db.run("delete from _rig_cache");
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.inFlight.values());
  }

  close(): void {
    this.db.close(false);
  }

  private staleTime(value: number | undefined): number {
    const staleTime = value ?? 0;
    if (typeof staleTime !== "number" || Number.isNaN(staleTime) || staleTime < 0) {
      throw new RigError("INPUT_ERROR", "context.cache staleTime must be a non-negative number.");
    }
    return staleTime;
  }

  private read<T>(
    identity: CacheIdentity,
  ): { data: T; updatedAt: number; invalidatedAt: number | null } | undefined {
    const row = this.db
      .query(
        "select key_json, value_json, data_updated_at, invalidated_at from _rig_cache where key_hash = ?",
      )
      .get(identity.hash) as CacheRow | null;
    if (!row) return undefined;
    if (row.key_json !== identity.json) {
      throw new RigError("TOOL_INVALID", "context.cache detected a query key hash collision.", {
        path: this.path,
      });
    }
    this.db
      .query("update _rig_cache set last_accessed_at = $lastAccessedAt where key_hash = $keyHash")
      .run({ keyHash: identity.hash, lastAccessedAt: this.now() });
    return {
      data: JSON.parse(row.value_json) as T,
      updatedAt: row.data_updated_at,
      invalidatedAt: row.invalidated_at,
    };
  }

  private write(identity: CacheIdentity, value: unknown): void {
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) {
      throw new RigError("INPUT_ERROR", "context.cache cannot store undefined values.", {
        queryKey: identity.json,
      });
    }
    const timestamp = this.now();
    this.db
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

  private refresh<T>(
    identity: CacheIdentity,
    queryFn: () => T | Promise<T>,
    background: boolean,
  ): Promise<T> {
    const existing = this.inFlight.get(identity.hash);
    if (existing) return existing as Promise<T>;

    const promise = Promise.resolve()
      .then(queryFn)
      .then((value) => {
        this.write(identity, value);
        return value;
      });
    this.inFlight.set(identity.hash, promise);
    void promise.then(
      () => this.inFlight.delete(identity.hash),
      (error) => {
        this.inFlight.delete(identity.hash);
        if (background) {
          this.log.warn({ err: error, queryKey: identity.json }, "Cache revalidation failed.");
        }
      },
    );
    return promise;
  }
}

class UnavailableToolCache implements ManagedRigToolCache {
  constructor(readonly path: string) {}

  query(): never {
    throw this.error();
  }

  peek(): never {
    throw this.error();
  }

  set(): never {
    throw this.error();
  }

  invalidate(): never {
    throw this.error();
  }

  remove(): never {
    throw this.error();
  }

  clear(): never {
    throw this.error();
  }

  async settle(): Promise<void> {}

  close(): void {}

  private error(): RigError {
    return new RigError(
      "TOOL_INVALID",
      "context.cache requires the Bun SQLite runtime. Run rig through its normal Bun bootstrap.",
      { path: this.path },
    );
  }
}

class RigToolCacheFactory {
  private readonly sqlite = new BunSqliteModuleLoader();

  async create(toolPath: string, log: RigToolLogger): Promise<ManagedRigToolCache> {
    const cachePath = this.cachePathForToolPath(toolPath);
    if (!this.sqlite.available()) return new UnavailableToolCache(cachePath);

    await mkdir(dirname(cachePath), { recursive: true });
    const Database = await this.sqlite.database();
    const db = new Database(cachePath, { create: true, strict: true });
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
    return new SqliteToolCache(db, cachePath, log);
  }

  cachePathForToolPath(toolPath: string): string {
    return join(dirname(toolPath), "cache.sqlite");
  }
}

export class ToolCacheService {
  private readonly factory = new RigToolCacheFactory();

  async setup(tool: LoadedTool, log: RigToolLogger): Promise<ManagedRigToolCache> {
    return this.factory.create(tool.path, log);
  }

  cachePathForToolPath(toolPath: string): string {
    return this.factory.cachePathForToolPath(toolPath);
  }
}
