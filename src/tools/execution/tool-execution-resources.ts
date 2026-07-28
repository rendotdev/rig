import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ToolCollectionServiceClass, type CollectionHandle } from "../collection";
import { type ManagedRigToolCache, ToolCacheServiceClass } from "../cache";
import { ToolDatabaseServiceClass } from "../db";
import { type ManagedRigToolKvStore, ToolKvStoreServiceClass } from "../kv";
import type { LoadedTool, RigToolDatabase, RigToolLogger } from "../types";

export const ToolExecutionOperation = Schema.Literals([
  "database",
  "kv",
  "cache",
  "collections",
  "command",
  "output",
]);

export type ToolExecutionOperation = typeof ToolExecutionOperation.Type;

export class ToolExecutionError extends Schema.TaggedErrorClass<ToolExecutionError>()(
  "ToolExecutionError",
  {
    operation: ToolExecutionOperation,
    cause: Schema.Defect(),
  },
) {}

export type ToolExecutionResourceSet = Readonly<{
  db: RigToolDatabase | undefined;
  kv: ManagedRigToolKvStore;
  cache: ManagedRigToolCache;
  collections: Record<string, CollectionHandle<any>> | undefined;
}>;

export type ToolExecutionResourceDependencies = Readonly<{
  setupDatabase: (tool: LoadedTool) => Promise<RigToolDatabase | undefined>;
  closeDatabase: (db: RigToolDatabase | undefined) => void;
  setupKv: (tool: LoadedTool) => Promise<ManagedRigToolKvStore>;
  closeKv: (kv: ManagedRigToolKvStore) => void;
  setupCache: (tool: LoadedTool, log: RigToolLogger) => Promise<ManagedRigToolCache>;
  closeCache: (cache: ManagedRigToolCache) => void;
  setupCollections: (
    tool: LoadedTool,
  ) => Promise<Record<string, CollectionHandle<any>> | undefined>;
  closeCollections: (collections: Record<string, CollectionHandle<any>> | undefined) => void;
}>;

export class ToolExecutionResources extends Context.Service<
  ToolExecutionResources,
  {
    readonly acquire: (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) => Effect.Effect<ToolExecutionResourceSet, ToolExecutionError, Scope.Scope>;
  }
>()("@rendotdev/rig/tools/execution/ToolExecutionResources") {
  static readonly makeLayer = (
    dependencies: ToolExecutionResourceDependencies,
  ): Layer.Layer<ToolExecutionResources> => {
    const acquire = Effect.fn("ToolExecutionResources.acquire")(function* (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) {
      const scoped = <Resource>(
        operation: ToolExecutionOperation,
        open: () => Promise<Resource>,
        close: (resource: Resource) => void,
      ) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: open,
            catch: (cause) => new ToolExecutionError({ operation, cause }),
          }),
          (resource) =>
            Effect.sync(() => {
              try {
                close(resource);
              } catch (cause) {
                params.log.warn(
                  { err: cause, operation },
                  "Tool resource cleanup failed; remaining finalizers will continue.",
                );
              }
            }),
        );

      const db = yield* scoped(
        "database",
        () => dependencies.setupDatabase(params.tool),
        dependencies.closeDatabase,
      );
      const kv = yield* scoped("kv", () => dependencies.setupKv(params.tool), dependencies.closeKv);
      const cache = yield* scoped(
        "cache",
        () => dependencies.setupCache(params.tool, params.log),
        dependencies.closeCache,
      );
      const collections = yield* scoped(
        "collections",
        () => dependencies.setupCollections(params.tool),
        dependencies.closeCollections,
      );

      return { db, kv, cache, collections };
    });

    return Layer.succeed(ToolExecutionResources, { acquire });
  };

  static readonly layer = ToolExecutionResources.makeLayer({
    setupDatabase: (tool) => new ToolDatabaseServiceClass().setup(tool),
    closeDatabase: (db) => db?.close(false),
    setupKv: (tool) => new ToolKvStoreServiceClass().setup(tool),
    closeKv: (kv) => kv.close(),
    setupCache: (tool, log) => new ToolCacheServiceClass().setup(tool, log),
    closeCache: (cache) => cache.close(),
    setupCollections: (tool) => new ToolCollectionServiceClass().setup(tool),
    closeCollections: (collections) => new ToolCollectionServiceClass().close(collections),
  });
}
