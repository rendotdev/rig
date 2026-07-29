import { Context, Effect, Layer, Scope } from "effect";
import { ToolCollectionsService, toolCollectionsLayer } from "./tool-collections";
import type { CollectionHandle } from "../../collections/types/tool-collection";
import {
  ToolPersistenceService,
  toolPersistenceLayer,
  type ToolPersistenceResourceSet,
} from "../service/tool-persistence";
import { ToolExecutionError } from "../types/tool-execution";
import type { LoadedTool, RigToolDatabase, RigToolLogger } from "../types/tool-types";

export type ToolExecutionResourceSet = Readonly<{
  db: RigToolDatabase;
  kv: ToolPersistenceResourceSet["kv"];
  cache: ToolPersistenceResourceSet["cache"];
  collections: Record<string, CollectionHandle<any>> | undefined;
}>;

export class ToolExecutionResourcesService extends Context.Service<
  ToolExecutionResourcesService,
  {
    readonly acquire: (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) => Effect.Effect<ToolExecutionResourceSet, ToolExecutionError, Scope.Scope>;
  }
>()("@rendotdev/rig/tools/execution/ToolExecutionResourcesService", {
  make: Effect.gen(function* () {
    const persistence = yield* ToolPersistenceService;
    const collections = yield* ToolCollectionsService;
    const acquire = Effect.fn("ToolExecutionResourcesService.acquire")(function* (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) {
      const { db, kv, cache } = yield* persistence.acquire(params);
      const collectionHandles = yield* collections
        .acquire(params.tool)
        .pipe(
          Effect.mapError((cause) => new ToolExecutionError({ operation: "collections", cause })),
        );
      return { db, kv, cache, collections: collectionHandles };
    });
    return { acquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolExecutionResourcesService,
    ToolExecutionResourcesService.make,
  );
}

export const toolExecutionResourcesLayer = ToolExecutionResourcesService.layer.pipe(
  Layer.provide(Layer.merge(toolPersistenceLayer, toolCollectionsLayer)),
);
