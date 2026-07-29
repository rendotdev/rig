import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";
import type { CollectionFileRecord, DocRow } from "../../types/tool-collection";

export class CollectionIndexRecordReaderService extends Context.Service<
  CollectionIndexRecordReaderService,
  {
    readonly getFile: (
      database: Database,
      id: string,
    ) => Effect.Effect<CollectionFileRecord | null, RigError>;
    readonly allFileIds: (database: Database) => Effect.Effect<string[], RigError>;
    readonly getDoc: (database: Database, id: string) => Effect.Effect<DocRow | null, RigError>;
    readonly allIds: (database: Database) => Effect.Effect<string[], RigError>;
  }
>()("@rendotdev/rig/collections/CollectionIndexRecordReaderService", {
  make: Effect.gen(function* () {
    const run = <Value>(operation: () => Value) =>
      Effect.try({
        try: operation,
        catch: (cause) =>
          new RigError({ code: "INTERNAL_ERROR", message: String(cause), details: cause }),
      });
    const getFile = Effect.fn("CollectionIndexRecordReaderService.getFile")(function* (
      database: Database,
      id: string,
    ) {
      return yield* run(() => {
        const row = database
          .query("SELECT id, mtime_ms, ctime_ms, size, status FROM collection_files WHERE id = $id")
          .get({ id }) as any;
        return row
          ? {
              id: row.id,
              mtimeMs: row.mtime_ms,
              ctimeMs: row.ctime_ms,
              size: row.size,
              status: row.status,
            }
          : null;
      });
    });
    const allFileIds = Effect.fn("CollectionIndexRecordReaderService.allFileIds")(function* (
      database: Database,
    ) {
      return yield* run(() =>
        (database.query("SELECT id FROM collection_files").all() as { id: string }[]).map(
          (row) => row.id,
        ),
      );
    });
    const getDoc = Effect.fn("CollectionIndexRecordReaderService.getDoc")(function* (
      database: Database,
      id: string,
    ) {
      return yield* run(
        () => database.query("SELECT * FROM docs WHERE id = $id").get({ id }) as DocRow | null,
      );
    });
    const allIds = Effect.fn("CollectionIndexRecordReaderService.allIds")(function* (
      database: Database,
    ) {
      return yield* run(() =>
        (database.query("SELECT id FROM docs").all() as { id: string }[]).map((row) => row.id),
      );
    });
    return { getFile, allFileIds, getDoc, allIds } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexRecordReaderService,
    CollectionIndexRecordReaderService.make,
  );
}
