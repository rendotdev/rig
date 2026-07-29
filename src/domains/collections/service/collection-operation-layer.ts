import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { CollectionDocumentPathService } from "../repo/collection-document-path";
import {
  CollectionDocumentIoService,
  CollectionDocumentRepositoryService,
} from "../repo/collection-document-repository";
import { CollectionEntryCodecService } from "../repo/collection-entry-codec";
import { CollectionQueryService } from "../repo/collection-query";
import { CollectionReconciliationService } from "../repo/collection-reconciliation";
import { frontmatterCodecLayer } from "../repo/frontmatter-codec";
import {
  SqliteCollectionIndexService,
  sqliteCollectionIndexLayer,
} from "../repo/sqlite/sqlite-collection-index";
import type {
  CollectionData,
  CollectionOperationContext,
} from "../types/collection-operation-context";
import type {
  CollectionEntry,
  CollectionIndexInterface,
  ListOptions,
  SearchResult,
} from "../types/tool-collection";

export class CollectionOperationService extends Context.Service<
  CollectionOperationService,
  {
    readonly createIndex: (
      collectionPath: string,
    ) => Effect.Effect<CollectionIndexInterface, RigError>;
    readonly reconcile: (context: CollectionOperationContext) => Effect.Effect<void, RigError>;
    readonly create: (
      context: CollectionOperationContext,
      input: { id?: string; data: CollectionData; body?: string },
    ) => Effect.Effect<CollectionEntry<CollectionData>, RigError>;
    readonly getEntry: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<CollectionEntry<CollectionData> | null, RigError>;
    readonly update: (
      context: CollectionOperationContext,
      id: string,
      patch: { data?: CollectionData; body?: string },
    ) => Effect.Effect<CollectionEntry<CollectionData>, RigError>;
    readonly upsert: (
      context: CollectionOperationContext,
      input: { id: string; data: CollectionData; body?: string },
    ) => Effect.Effect<{ id: string; created: boolean }, RigError>;
    readonly remove: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<boolean, RigError>;
    readonly clear: (context: CollectionOperationContext) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionOperationService", {
  make: Effect.gen(function* () {
    const indexes = yield* SqliteCollectionIndexService;
    const documents = yield* CollectionDocumentRepositoryService;
    const reconciliation = yield* CollectionReconciliationService;
    const createIndex = Effect.fn("CollectionOperationService.createIndex")(function* (
      collectionPath: string,
    ) {
      return yield* indexes.create(collectionPath);
    });
    const reconcile = Effect.fn("CollectionOperationService.reconcile")(function* (
      context: CollectionOperationContext,
    ) {
      yield* reconciliation.reconcile(context);
    });
    const create = Effect.fn("CollectionOperationService.create")(function* (
      context: CollectionOperationContext,
      input: { id?: string; data: CollectionData; body?: string },
    ) {
      return yield* documents.create(context, input);
    });
    const getEntry = Effect.fn("CollectionOperationService.getEntry")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      return yield* documents.getEntry(context, id);
    });
    const update = Effect.fn("CollectionOperationService.update")(function* (
      context: CollectionOperationContext,
      id: string,
      patch: { data?: CollectionData; body?: string },
    ) {
      return yield* documents.update(context, id, patch);
    });
    const upsert = Effect.fn("CollectionOperationService.upsert")(function* (
      context: CollectionOperationContext,
      input: { id: string; data: CollectionData; body?: string },
    ) {
      return yield* documents.upsert(context, input);
    });
    const remove = Effect.fn("CollectionOperationService.remove")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      return yield* documents.remove(context, id);
    });
    const clear = Effect.fn("CollectionOperationService.clear")(function* (
      context: CollectionOperationContext,
    ) {
      yield* documents.clear(context);
    });
    return {
      createIndex,
      reconcile,
      create,
      getEntry,
      update,
      upsert,
      remove,
      clear,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(CollectionOperationService, CollectionOperationService.make);
}

export class CollectionReadService extends Context.Service<
  CollectionReadService,
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
>()("@rendotdev/rig/collections/CollectionReadService", {
  make: Effect.gen(function* () {
    const queries = yield* CollectionQueryService;
    const list = Effect.fn("CollectionReadService.list")(function* (
      context: CollectionOperationContext,
      options?: ListOptions,
    ) {
      return yield* queries.list(context, options);
    });
    const search = Effect.fn("CollectionReadService.search")(function* (
      context: CollectionOperationContext,
      query: string,
      options?: { limit?: number },
    ) {
      return yield* queries.search(context, query, options);
    });
    const count = Effect.fn("CollectionReadService.count")(function* (
      context: CollectionOperationContext,
      where?: Record<string, unknown>,
    ) {
      return yield* queries.count(context, where);
    });
    const getCollection = Effect.fn("CollectionReadService.getCollection")(function* (
      context: CollectionOperationContext,
      filter?: (entry: CollectionEntry<CollectionData>) => boolean,
    ) {
      return yield* queries.getCollection(context, filter);
    });
    return { list, search, count, getCollection } as const;
  }),
}) {
  static readonly layer = Layer.effect(CollectionReadService, CollectionReadService.make);
}

const collectionEntryLayer = CollectionEntryCodecService.layer;
const collectionPathLayer = CollectionDocumentPathService.layer;
const collectionDocumentIoLayer = CollectionDocumentIoService.layer.pipe(
  Layer.provide(Layer.mergeAll(collectionEntryLayer, collectionPathLayer, frontmatterCodecLayer)),
);
const collectionReconciliationLayer = CollectionReconciliationService.layer.pipe(
  Layer.provide(Layer.mergeAll(collectionEntryLayer, collectionPathLayer, frontmatterCodecLayer)),
);
const collectionDocumentRepositoryLayer = CollectionDocumentRepositoryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(collectionDocumentIoLayer, collectionEntryLayer, collectionPathLayer),
  ),
);
const collectionOperationRepositoryLayer = Layer.mergeAll(
  sqliteCollectionIndexLayer,
  collectionDocumentRepositoryLayer,
  collectionReconciliationLayer,
  CollectionQueryService.layer.pipe(Layer.provide(collectionEntryLayer)),
);

export const collectionOperationLayer = CollectionOperationService.layer.pipe(
  Layer.provide(collectionOperationRepositoryLayer),
  Layer.merge(CollectionReadService.layer.pipe(Layer.provide(collectionOperationRepositoryLayer))),
);
