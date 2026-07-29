import { dirname, join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolIdentifierService, toolIdentifierLayer } from "../service/tool-identifier";
import type { LoadedTool } from "../types/tool-types";
import {
  CollectionHandleFactoryService,
  collectionHandleFactoryLayer,
} from "../../collections/runtime/collection-handle-factory";
import type {
  CollectionDefinition,
  CollectionHandle,
} from "../../collections/types/tool-collection";

type ToolDefinitionWithCollections = {
  collections?: Record<string, CollectionDefinition | undefined>;
};

export class ToolCollectionsService extends Context.Service<
  ToolCollectionsService,
  {
    readonly setup: (
      tool: LoadedTool,
    ) => Effect.Effect<Record<string, CollectionHandle<any>> | undefined, RigError>;
    readonly acquire: (
      tool: LoadedTool,
    ) => Effect.Effect<Record<string, CollectionHandle<any>> | undefined, RigError, Scope.Scope>;
    readonly close: (
      handles: Record<string, CollectionHandle<any>> | undefined,
    ) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/collections/ToolCollectionsService", {
  make: Effect.gen(function* () {
    const handleFactory = yield* CollectionHandleFactoryService;
    const identifiers = yield* ToolIdentifierService;
    const definitionsFor = (tool: LoadedTool) =>
      (tool.definition as ToolDefinitionWithCollections).collections;
    const close = Effect.fn("ToolCollectionsService.close")(function* (
      handles: Record<string, CollectionHandle<any>> | undefined,
    ) {
      if (!handles) return;
      for (const handle of Object.values(handles)) {
        (handle as CollectionHandle<any> & { close?: () => void }).close?.();
      }
    });
    const setup = Effect.fn("ToolCollectionsService.setup")(function* (tool: LoadedTool) {
      const definitions = definitionsFor(tool);
      const hasNoCollections = !definitions || Object.keys(definitions).length === 0;
      if (hasNoCollections) return undefined;
      const toolDirectory = dirname(tool.path);
      const entries = yield* Effect.forEach(Object.entries(definitions), ([name, definition]) =>
        Effect.gen(function* () {
          const collectionName = (yield* identifiers.parseCollectionName(name)).value;
          const handle = yield* handleFactory.createLazy(
            collectionName,
            join(toolDirectory, collectionName),
            definition ?? {},
          );
          return [name, handle] as const;
        }),
      );
      return Object.fromEntries(entries);
    });
    const acquire = Effect.fn("ToolCollectionsService.acquire")(function* (tool: LoadedTool) {
      return yield* Effect.acquireRelease(setup(tool), close);
    });

    return { setup, acquire, close } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolCollectionsService, ToolCollectionsService.make);
}

export const toolCollectionsLayer = ToolCollectionsService.layer.pipe(
  Layer.provide(Layer.merge(collectionHandleFactoryLayer, toolIdentifierLayer)),
);
