import { Context, Effect, Layer } from "effect";
import type {
  CollectionData,
  CollectionOperationContext,
} from "../types/collection-operation-context";
import type { CollectionEntry, DocRow, ListOptions, SearchResult } from "../types/tool-collection";
import { CollectionEntryCodecService } from "./collection-entry-codec";

export class CollectionQueryService extends Context.Service<
  CollectionQueryService,
  {
    readonly list: (
      context: CollectionOperationContext,
      options?: ListOptions,
    ) => Effect.Effect<{ entries: CollectionEntry<CollectionData>[]; total: number }>;
    readonly search: (
      context: CollectionOperationContext,
      query: string,
      options?: { limit?: number },
    ) => Effect.Effect<{ entries: SearchResult<CollectionData>[] }>;
    readonly count: (
      context: CollectionOperationContext,
      where?: Record<string, unknown>,
    ) => Effect.Effect<number>;
    readonly getCollection: (
      context: CollectionOperationContext,
      filter?: (entry: CollectionEntry<CollectionData>) => boolean,
    ) => Effect.Effect<CollectionEntry<CollectionData>[]>;
  }
>()("@rendotdev/rig/collections/CollectionQueryService", {
  make: Effect.gen(function* () {
    const entries = yield* CollectionEntryCodecService;
    const list = Effect.fn("CollectionQueryService.list")(function* (
      context: CollectionOperationContext,
      options: ListOptions = {},
    ) {
      const result = context.index.listDocs(options);
      return {
        entries: yield* Effect.forEach(result.rows, entries.rowToEntry),
        total: result.total,
      };
    });
    const search = Effect.fn("CollectionQueryService.search")(function* (
      context: CollectionOperationContext,
      query: string,
      options?: { limit?: number },
    ) {
      const rows = context.index.searchDocs(query, options?.limit ?? 10) as Array<
        DocRow & { rank: number }
      >;
      return {
        entries: yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            return {
              ...(yield* entries.rowToEntry(row)),
              snippet: yield* entries.snippet(row.body, query),
              rank: row.rank,
            };
          }),
        ),
      };
    });
    const count = Effect.fn("CollectionQueryService.count")(function* (
      context: CollectionOperationContext,
      where?: Record<string, unknown>,
    ) {
      return context.index.countDocs(where);
    });
    const getCollection = Effect.fn("CollectionQueryService.getCollection")(function* (
      context: CollectionOperationContext,
      filter?: (entry: CollectionEntry<CollectionData>) => boolean,
    ) {
      const result = yield* list(context, { limit: 100_000 });
      return filter ? result.entries.filter((entry) => filter(entry)) : result.entries;
    });
    return { list, search, count, getCollection } as const;
  }),
}) {
  static readonly layer = Layer.effect(CollectionQueryService, CollectionQueryService.make);
}
