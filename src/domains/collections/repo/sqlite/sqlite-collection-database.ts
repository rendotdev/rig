import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";
import { SqlitePlatformService } from "../../../../providers/database/sqlite";
import { RigError } from "../../../../providers/errors/rig-error";

const COLLECTION_INDEX_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS docs (
    id TEXT PRIMARY KEY, data_json TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, file_mtime REAL NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS collection_files (
    id TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
    size INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('indexed', 'invalid'))
  );`,
  "CREATE TABLE IF NOT EXISTS collection_health (key TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);",
  "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id, data_json, body, content=docs, content_rowid=rowid);",
  `CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, id, data_json, body) VALUES (new.rowid, new.id, new.data_json, new.body);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, id, data_json, body)
    VALUES ('delete', old.rowid, old.id, old.data_json, old.body);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, id, data_json, body)
    VALUES ('delete', old.rowid, old.id, old.data_json, old.body);
    INSERT INTO docs_fts(rowid, id, data_json, body) VALUES (new.rowid, new.id, new.data_json, new.body);
  END;`,
] as const;

class CollectionIndexCorruptionError extends Schema.TaggedErrorClass<CollectionIndexCorruptionError>()(
  "CollectionIndexCorruptionError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

class CollectionIndexDatabaseInitializerService extends Context.Service<
  CollectionIndexDatabaseInitializerService,
  {
    readonly initialize: (
      Database: new (path: string, options?: object) => Database,
      path: string,
    ) => Effect.Effect<Database, RigError | CollectionIndexCorruptionError>;
    readonly isRecoverable: (error: unknown) => Effect.Effect<boolean>;
  }
>()("@rendotdev/rig/collections/CollectionIndexDatabaseInitializerService", {
  make: Effect.gen(function* () {
    const recoverable = (error: unknown) => {
      if (error instanceof CollectionIndexCorruptionError) return true;
      if (!Predicate.isObject(error)) return false;
      const cause = error instanceof RigError ? error.details : error;
      if (!Predicate.isObject(cause)) return false;
      const code = "code" in cause ? String(cause.code) : undefined;
      const isCorruptDatabaseCode = code === "SQLITE_NOTADB" || code?.startsWith("SQLITE_CORRUPT");
      if (isCorruptDatabaseCode) return true;
      const sqliteError = code === "SQLITE_ERROR" || ("errno" in cause && cause.errno === 1);
      return (
        sqliteError &&
        "message" in cause &&
        String(cause.message).toLowerCase().includes("no such column")
      );
    };
    const validate = (database: Database) => {
      database.query("SELECT id, data_json, body, created_at, updated_at FROM docs LIMIT 0").all();
      database
        .query("SELECT id, mtime_ms, ctime_ms, size, status FROM collection_files LIMIT 0")
        .all();
      database.query("SELECT rowid, id, data_json, body FROM docs_fts LIMIT 0").all();
      const checked = database
        .query("SELECT checked_at FROM collection_health WHERE key = 'integrity'")
        .get() as { checked_at: number } | null;
      const hasRecentIntegrityCheck =
        checked !== null && Date.now() - checked.checked_at < 86_400_000;
      if (hasRecentIntegrityCheck) return;
      const results = (
        database.query("PRAGMA quick_check;").all() as Record<string, unknown>[]
      ).flatMap((row) => Object.values(row));
      const hasFailedIntegrityCheck = results.length !== 1 || results[0] !== "ok";
      if (hasFailedIntegrityCheck) {
        throw new CollectionIndexCorruptionError({
          message: `Collection index integrity check failed: ${results.join(", ")}`,
          cause: results,
        });
      }
      database
        .query(
          `INSERT INTO collection_health (key, checked_at) VALUES ('integrity', $checkedAt)
         ON CONFLICT(key) DO UPDATE SET checked_at = excluded.checked_at`,
        )
        .run({ checkedAt: Date.now() });
    };
    const initialize = Effect.fn("CollectionIndexDatabaseInitializerService.initialize")(function* (
      Database: new (path: string, options?: object) => Database,
      path: string,
    ) {
      return yield* Effect.try({
        try: () => {
          const database = new Database(path, { create: true, strict: true });
          try {
            database.run("PRAGMA busy_timeout = 5000;");
            database.run("PRAGMA journal_mode = WAL;");
            for (const sql of COLLECTION_INDEX_SCHEMA_SQL) database.run(sql);
            validate(database);
            return database;
          } catch (error) {
            database.close(false);
            throw error;
          }
        },
        catch: (cause) =>
          cause instanceof CollectionIndexCorruptionError
            ? cause
            : new RigError({
                code: "INTERNAL_ERROR",
                message: cause instanceof Error ? cause.message : String(cause),
                details: cause,
              }),
      });
    });
    const isRecoverable = Effect.fn("CollectionIndexDatabaseInitializerService.isRecoverable")(
      function* (error: unknown) {
        return recoverable(error);
      },
    );
    return { initialize, isRecoverable } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexDatabaseInitializerService,
    CollectionIndexDatabaseInitializerService.make,
  );
}

export class CollectionIndexDatabaseService extends Context.Service<
  CollectionIndexDatabaseService,
  { readonly open: (collectionPath: string) => Effect.Effect<Database, RigError> }
>()("@rendotdev/rig/collections/CollectionIndexDatabaseService", {
  make: Effect.gen(function* () {
    const sqlite = yield* SqlitePlatformService;
    const initializer = yield* CollectionIndexDatabaseInitializerService;
    const Database = (yield* sqlite.available) ? yield* sqlite.load : undefined;
    const normalizeError = (cause: unknown) =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
            details: cause,
          });
    const open = Effect.fn("CollectionIndexDatabaseService.open")(function* (
      collectionPath: string,
    ) {
      if (!Database) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: "Collections require the Bun SQLite runtime.",
        });
      }
      const path = join(collectionPath, ".index.sqlite");
      const first = yield* Effect.result(initializer.initialize(Database, path));
      if (Result.isSuccess(first)) return first.success;
      if (!(yield* initializer.isRecoverable(first.failure))) {
        return yield* normalizeError(first.failure);
      }
      yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            [path, `${path}-shm`, `${path}-wal`].map((file) => rm(file, { force: true })),
          ),
        catch: normalizeError,
      });
      return yield* initializer.initialize(Database, path).pipe(Effect.mapError(normalizeError));
    });
    return { open } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexDatabaseService,
    CollectionIndexDatabaseService.make,
  );
}

export const collectionIndexDatabaseLayer = CollectionIndexDatabaseService.layer.pipe(
  Layer.provide(
    Layer.merge(SqlitePlatformService.layer, CollectionIndexDatabaseInitializerService.layer),
  ),
);
