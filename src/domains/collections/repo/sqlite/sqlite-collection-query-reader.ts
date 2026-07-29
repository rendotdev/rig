import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";
import type { DocRow, ListOptions } from "../../types/tool-collection";
import { CollectionIndexQueryCompilerService } from "./sqlite-collection-query-compiler";

export class CollectionIndexQueryReaderService extends Context.Service<
  CollectionIndexQueryReaderService,
  {
    readonly listDocs: (
      database: Database,
      options: ListOptions,
    ) => Effect.Effect<{ rows: DocRow[]; total: number }, RigError>;
    readonly searchDocs: (
      database: Database,
      text: string,
      limit: number,
    ) => Effect.Effect<DocRow[], RigError>;
    readonly countDocs: (
      database: Database,
      where?: Record<string, unknown>,
    ) => Effect.Effect<number, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionIndexQueryReaderService", {
  make: Effect.gen(function* () {
    const query = yield* CollectionIndexQueryCompilerService;
    const run = <Value>(operation: () => Value) =>
      Effect.try({
        try: operation,
        catch: (cause) =>
          new RigError({ code: "INTERNAL_ERROR", message: String(cause), details: cause }),
      });
    const listDocs = Effect.fn("CollectionIndexQueryReaderService.listDocs")(function* (
      database: Database,
      options: ListOptions,
    ) {
      const filter =
        options.where && Object.keys(options.where).length > 0
          ? yield* query.where(options.where)
          : { sql: "", parameters: {} };
      const where = filter.sql ? `WHERE ${filter.sql}` : "";
      const descending = options.sort?.startsWith("-") ?? false;
      const sort = options.sort
        ? yield* query.fieldPath(descending ? options.sort.slice(1) : options.sort)
        : undefined;
      const order = sort
        ? `ORDER BY json_extract(data_json, '${sort}') ${descending ? "DESC" : "ASC"}`
        : "ORDER BY updated_at DESC";
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return yield* run(() => {
        const total = (
          database
            .query(`SELECT COUNT(*) as cnt FROM docs ${where}`)
            .get(filter.parameters as any) as { cnt: number }
        ).cnt;
        const rows = database
          .query(`SELECT * FROM docs ${where} ${order} LIMIT $limit OFFSET $offset`)
          .all({ ...filter.parameters, limit, offset } as any) as DocRow[];
        return { rows, total };
      });
    });
    const searchDocs = Effect.fn("CollectionIndexQueryReaderService.searchDocs")(function* (
      database: Database,
      text: string,
      limit: number,
    ) {
      return yield* run(
        () =>
          database
            .query(
              `SELECT docs.*, docs_fts.rank FROM docs_fts JOIN docs ON docs.id = docs_fts.id
         WHERE docs_fts MATCH $query ORDER BY docs_fts.rank LIMIT $limit`,
            )
            .all({ query: text, limit }) as DocRow[],
      );
    });
    const countDocs = Effect.fn("CollectionIndexQueryReaderService.countDocs")(function* (
      database: Database,
      where?: Record<string, unknown>,
    ) {
      const hasNoFilters = !where || Object.keys(where).length === 0;
      if (hasNoFilters) {
        return yield* run(
          () => (database.query("SELECT COUNT(*) as cnt FROM docs").get() as { cnt: number }).cnt,
        );
      }
      const filter = yield* query.where(where);
      return yield* run(
        () =>
          (
            database
              .query(`SELECT COUNT(*) as cnt FROM docs WHERE ${filter.sql}`)
              .get(filter.parameters as any) as { cnt: number }
          ).cnt,
      );
    });
    return { listDocs, searchDocs, countDocs } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexQueryReaderService,
    CollectionIndexQueryReaderService.make,
  );
}

export const collectionIndexQueryReaderLayer = CollectionIndexQueryReaderService.layer.pipe(
  Layer.provide(CollectionIndexQueryCompilerService.layer),
);
