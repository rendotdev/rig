import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { FileLockService, fileLockLayer } from "../../../providers/filesystem/file-lock";
import { RigError } from "../../../providers/errors/rig-error";
import {
  CollectionOperationService,
  CollectionReadService,
  collectionOperationLayer,
} from "../service/collection-operation-layer";
import type {
  CollectionDefinition,
  CollectionEntry,
  CollectionHandle,
  CollectionIndexInterface,
  ListOptions,
  ManagedCollectionHandle,
} from "../types/tool-collection";

export class CollectionHandleResourceService extends Context.Service<
  CollectionHandleResourceService,
  {
    readonly create: (
      name: string,
      path: string,
      definition: CollectionDefinition,
      index?: CollectionIndexInterface,
    ) => Effect.Effect<ManagedCollectionHandle, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionHandleResourceService", {
  make: Effect.gen(function* () {
    const operations = yield* CollectionOperationService;
    const reads = yield* CollectionReadService;
    const initialization = yield* CollectionHandleInitializationService;
    const runtimeContext = yield* Effect.context<never>();
    const create = Effect.fn("CollectionHandleResourceService.create")(function* (
      name: string,
      path: string,
      definition: CollectionDefinition,
      provided?: CollectionIndexInterface,
    ) {
      const index = provided ?? (yield* operations.createIndex(path));
      const context = { path, definition, index } as const;
      const run = Effect.runPromiseWith(runtimeContext);
      const init = () => run(initialization.initialize(path, index, operations.reconcile(context)));
      const close = () => index.close();
      const handle: ManagedCollectionHandle = {
        name,
        path,
        create: (input) => run(operations.create(context, input)),
        getEntry: (id) => run(operations.getEntry(context, id)),
        update: (id, patch) => run(operations.update(context, id, patch)),
        upsert: (input) => run(operations.upsert(context, input)),
        remove: (id) => run(operations.remove(context, id)),
        list: (options) => run(reads.list(context, options)),
        search: (query, options) => run(reads.search(context, query, options)),
        count: (where) => run(reads.count(context, where)),
        getCollection: (filter) => run(reads.getCollection(context, filter)),
        clear: () => run(operations.clear(context)),
        init,
        close,
      };
      return handle;
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionHandleResourceService,
    CollectionHandleResourceService.make,
  );
}

export class CollectionHandleInitializationService extends Context.Service<
  CollectionHandleInitializationService,
  {
    readonly initialize: (
      path: string,
      index: CollectionIndexInterface,
      reconciliation: Effect.Effect<void, RigError>,
    ) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionHandleInitializationService", {
  make: Effect.gen(function* () {
    const locks = yield* FileLockService;
    const normalizeError = (cause: unknown) =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
            details: cause,
          });
    const initialize = Effect.fn("CollectionHandleInitializationService.initialize")(function* (
      path: string,
      index: CollectionIndexInterface,
      reconciliation: Effect.Effect<void, RigError>,
    ) {
      yield* locks
        .withLock({
          targetPath: join(path, ".index.sqlite"),
          operation: () =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => mkdir(path, { recursive: true }),
                catch: normalizeError,
              });
              yield* Effect.tryPromise({ try: () => index.open(), catch: normalizeError });
              yield* reconciliation;
            }),
        })
        .pipe(Effect.mapError(normalizeError));
    });
    return { initialize } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionHandleInitializationService,
    CollectionHandleInitializationService.make,
  );
}

export class LazyCollectionHandleService extends Context.Service<
  LazyCollectionHandleService,
  {
    readonly create: <T extends Record<string, unknown>>(
      handle: ManagedCollectionHandle,
    ) => Effect.Effect<CollectionHandle<T> & { close(): void }>;
  }
>()("@rendotdev/rig/collections/LazyCollectionHandleService", {
  make: Effect.gen(function* () {
    const create = Effect.fn("LazyCollectionHandleService.create")(function* <
      T extends Record<string, unknown>,
    >(handle: ManagedCollectionHandle) {
      let initialization: Promise<ManagedCollectionHandle> | undefined;
      let initialized: ManagedCollectionHandle | undefined;
      const resource = () =>
        (initialization ??= handle
          .init()
          .then(() => (initialized = handle))
          .catch((error) => {
            handle.close();
            initialization = undefined;
            throw error;
          }));
      const createEntry = (entry: { id?: string; data: T; body?: string }) =>
        resource().then((value) => value.create(entry));
      const getEntry = (id: string) => resource().then((value) => value.getEntry(id));
      const update = (id: string, patch: { data?: Partial<T>; body?: string }) =>
        resource().then((value) => value.update(id, patch));
      const upsert = (entry: { id: string; data: T; body?: string }) =>
        resource().then((value) => value.upsert(entry));
      const remove = (id: string) => resource().then((value) => value.remove(id));
      const list = (options?: ListOptions) => resource().then((value) => value.list(options));
      const search = (query: string, options?: { limit?: number }) =>
        resource().then((value) => value.search(query, options));
      const count = (where?: Record<string, unknown>) =>
        resource().then((value) => value.count(where));
      const getCollection = (filter?: (entry: CollectionEntry<T>) => boolean) =>
        resource().then((value) => value.getCollection(filter));
      const clear = () => resource().then((value) => value.clear());
      const close = () => initialized?.close();
      return {
        name: handle.name,
        path: handle.path,
        create: createEntry,
        getEntry,
        update,
        upsert,
        remove,
        list,
        search,
        count,
        getCollection,
        clear,
        close,
      };
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    LazyCollectionHandleService,
    LazyCollectionHandleService.make,
  );
}

export class CollectionHandleFactoryService extends Context.Service<
  CollectionHandleFactoryService,
  {
    readonly createLazy: <T extends Record<string, unknown>>(
      name: string,
      path: string,
      definition: CollectionDefinition,
      index?: CollectionIndexInterface,
    ) => Effect.Effect<CollectionHandle<T> & { close(): void }, RigError>;
    readonly acquire: <T extends Record<string, unknown>>(
      name: string,
      path: string,
      definition: CollectionDefinition,
      index?: CollectionIndexInterface,
    ) => Effect.Effect<CollectionHandle<T>, RigError, Scope.Scope>;
  }
>()("@rendotdev/rig/collections/CollectionHandleFactoryService", {
  make: Effect.gen(function* () {
    const resources = yield* CollectionHandleResourceService;
    const lazyHandles = yield* LazyCollectionHandleService;
    const toRigError = (error: unknown) => {
      if (error instanceof RigError) return error;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    };
    const createLazy = Effect.fn("CollectionHandleFactoryService.createLazy")(function* <
      T extends Record<string, unknown>,
    >(
      name: string,
      path: string,
      definition: CollectionDefinition,
      index?: CollectionIndexInterface,
    ) {
      return yield* lazyHandles.create<T>(yield* resources.create(name, path, definition, index));
    });
    const acquire = Effect.fn("CollectionHandleFactoryService.acquire")(function* <
      T extends Record<string, unknown>,
    >(
      name: string,
      path: string,
      definition: CollectionDefinition,
      index?: CollectionIndexInterface,
    ) {
      const handle = yield* resources.create(name, path, definition, index);
      return yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => handle.init(), catch: toRigError }).pipe(
          Effect.as(handle as CollectionHandle<T>),
        ),
        () => Effect.sync(() => handle.close()),
      );
    });
    return { createLazy, acquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionHandleFactoryService,
    CollectionHandleFactoryService.make,
  );
}

const collectionHandleInitializationLayer = CollectionHandleInitializationService.layer.pipe(
  Layer.provide(fileLockLayer),
);
const collectionHandleResourceLayer = CollectionHandleResourceService.layer.pipe(
  Layer.provide(Layer.mergeAll(collectionOperationLayer, collectionHandleInitializationLayer)),
);
export const collectionHandleFactoryLayer = CollectionHandleFactoryService.layer.pipe(
  Layer.provide(Layer.mergeAll(collectionHandleResourceLayer, LazyCollectionHandleService.layer)),
);
