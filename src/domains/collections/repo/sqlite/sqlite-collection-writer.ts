import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";
import type { CollectionEntry, CollectionFileRecord } from "../../types/tool-collection";

export class CollectionIndexWriterService extends Context.Service<
  CollectionIndexWriterService,
  {
    readonly upsertDoc: (
      database: Database,
      entry: CollectionEntry<Record<string, unknown>>,
      fileMtime: number,
    ) => Effect.Effect<void, RigError>;
    readonly deleteDoc: (database: Database, id: string) => Effect.Effect<void, RigError>;
    readonly upsertFile: (
      database: Database,
      record: CollectionFileRecord,
    ) => Effect.Effect<void, RigError>;
    readonly deleteFile: (database: Database, id: string) => Effect.Effect<void, RigError>;
    readonly clearAll: (database: Database) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionIndexWriterService", {
  make: Effect.gen(function* () {
    const run = (operation: () => unknown) =>
      Effect.try({
        try: () => void operation(),
        catch: (cause) =>
          new RigError({ code: "INTERNAL_ERROR", message: String(cause), details: cause }),
      });
    const upsertDoc = Effect.fn("CollectionIndexWriterService.upsertDoc")(function* (
      database: Database,
      entry: CollectionEntry<Record<string, unknown>>,
      fileMtime: number,
    ) {
      yield* run(() =>
        database
          .query(
            `INSERT INTO docs (id, data_json, body, created_at, updated_at, file_mtime)
           VALUES ($id, $dataJson, $body, $createdAt, $updatedAt, $fileMtime)
           ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json,
           body = excluded.body, updated_at = excluded.updated_at, file_mtime = excluded.file_mtime`,
          )
          .run({
            id: entry.id,
            dataJson: JSON.stringify(entry.data),
            body: entry.body,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            fileMtime,
          }),
      );
    });
    const deleteDoc = Effect.fn("CollectionIndexWriterService.deleteDoc")(function* (
      database: Database,
      id: string,
    ) {
      yield* run(() => database.query("DELETE FROM docs WHERE id = $id").run({ id }));
    });
    const upsertFile = Effect.fn("CollectionIndexWriterService.upsertFile")(function* (
      database: Database,
      record: CollectionFileRecord,
    ) {
      yield* run(() =>
        database
          .query(
            `INSERT INTO collection_files (id, mtime_ms, ctime_ms, size, status)
           VALUES ($id, $mtimeMs, $ctimeMs, $size, $status)
           ON CONFLICT(id) DO UPDATE SET mtime_ms = excluded.mtime_ms,
           ctime_ms = excluded.ctime_ms, size = excluded.size, status = excluded.status`,
          )
          .run(record),
      );
    });
    const deleteFile = Effect.fn("CollectionIndexWriterService.deleteFile")(function* (
      database: Database,
      id: string,
    ) {
      yield* run(() => database.query("DELETE FROM collection_files WHERE id = $id").run({ id }));
    });
    const clearAll = Effect.fn("CollectionIndexWriterService.clearAll")(function* (
      database: Database,
    ) {
      yield* run(() => {
        database.run("DELETE FROM docs");
        database.run("DELETE FROM collection_files");
      });
    });
    return { upsertDoc, deleteDoc, upsertFile, deleteFile, clearAll } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexWriterService,
    CollectionIndexWriterService.make,
  );
}
