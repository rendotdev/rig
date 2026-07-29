import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";
import type {
  CollectionEntry,
  CollectionFileRecord,
  CollectionIndexInterface,
  DocRow,
  ListOptions,
} from "../../types/tool-collection";
import { CollectionIndexDatabaseService } from "./sqlite-collection-database";
import { collectionIndexLayer } from "./sqlite-collection-layer";
import { CollectionIndexQueryReaderService } from "./sqlite-collection-query-reader";
import { CollectionIndexRecordReaderService } from "./sqlite-collection-record-reader";
import { CollectionIndexWriterService } from "./sqlite-collection-writer";

export class SqliteCollectionIndexService extends Context.Service<
  SqliteCollectionIndexService,
  { readonly create: (collectionPath: string) => Effect.Effect<CollectionIndexInterface, RigError> }
>()("@rendotdev/rig/collections/SqliteCollectionIndexService", {
  make: Effect.gen(function* () {
    const databases = yield* CollectionIndexDatabaseService;
    const writers = yield* CollectionIndexWriterService;
    const records = yield* CollectionIndexRecordReaderService;
    const queries = yield* CollectionIndexQueryReaderService;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const runSync = Effect.runSyncWith(runtimeContext);
    const create = Effect.fn("SqliteCollectionIndexService.create")(function* (
      collectionPath: string,
    ) {
      let database: Database | undefined;
      let initialization: Promise<void> | undefined;
      const current = () => {
        if (!database) {
          throw new RigError({ code: "TOOL_INVALID", message: "Collection index is not open." });
        }
        return database;
      };
      const initialize = async () => {
        database = await runPromise(databases.open(collectionPath));
      };
      const open = () =>
        (initialization ??= initialize().catch((error) => {
          initialization = undefined;
          throw error;
        }));
      const close = () => {
        database?.close(false);
        database = undefined;
        initialization = undefined;
      };
      return {
        open,
        upsertDoc: (entry: CollectionEntry<Record<string, unknown>>, fileMtime: number) =>
          runSync(writers.upsertDoc(current(), entry, fileMtime)),
        deleteDoc: (id: string) => runSync(writers.deleteDoc(current(), id)),
        upsertFile: (record: CollectionFileRecord) =>
          runSync(writers.upsertFile(current(), record)),
        deleteFile: (id: string) => runSync(writers.deleteFile(current(), id)),
        getFile: (id: string) => runSync(records.getFile(current(), id)),
        allFileIds: () => runSync(records.allFileIds(current())),
        getDoc: (id: string): DocRow | null => runSync(records.getDoc(current(), id)),
        listDocs: (options: ListOptions) => runSync(queries.listDocs(current(), options)),
        searchDocs: (query: string, limit: number) =>
          runSync(queries.searchDocs(current(), query, limit)),
        countDocs: (where?: Record<string, unknown>) =>
          runSync(queries.countDocs(current(), where)),
        allIds: () => runSync(records.allIds(current())),
        clearAll: () => runSync(writers.clearAll(current())),
        close,
      };
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    SqliteCollectionIndexService,
    SqliteCollectionIndexService.make,
  );
}

export const sqliteCollectionIndexLayer = SqliteCollectionIndexService.layer.pipe(
  Layer.provide(collectionIndexLayer),
);
