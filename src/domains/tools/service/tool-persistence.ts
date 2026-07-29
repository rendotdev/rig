import { Context, Effect, Layer, Scope } from "effect";
import { ToolCacheService, toolCacheLayer, type ManagedRigToolCache } from "../repo/tool-cache";
import { ToolDatabaseService, toolDatabaseLayer } from "../repo/tool-database";
import { ToolKvService, toolKvLayer, type ManagedRigToolKvStore } from "../repo/tool-kv";
import { ToolExecutionError } from "../types/tool-execution";
import type { LoadedTool, RigToolDatabase, RigToolLogger } from "../types/tool-types";

export type ToolPersistenceResourceSet = Readonly<{
  db: RigToolDatabase;
  kv: ManagedRigToolKvStore;
  cache: ManagedRigToolCache;
}>;

export class ToolPersistenceService extends Context.Service<
  ToolPersistenceService,
  {
    readonly acquire: (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) => Effect.Effect<ToolPersistenceResourceSet, ToolExecutionError, Scope.Scope>;
  }
>()("@rendotdev/rig/tools/service/ToolPersistenceService", {
  make: Effect.gen(function* () {
    const databases = yield* ToolDatabaseService;
    const keyValues = yield* ToolKvService;
    const caches = yield* ToolCacheService;
    const acquire = Effect.fn("ToolPersistenceService.acquire")(function* (params: {
      tool: LoadedTool;
      log: RigToolLogger;
    }) {
      const acquiredDatabase = yield* databases
        .acquire(params.tool)
        .pipe(Effect.mapError((cause) => new ToolExecutionError({ operation: "database", cause })));
      const db = acquiredDatabase ?? (yield* databases.unavailable(params.tool.name));
      const kv = yield* keyValues
        .acquire(params.tool)
        .pipe(Effect.mapError((cause) => new ToolExecutionError({ operation: "kv", cause })));
      const cache = yield* caches
        .acquire(params.tool, params.log)
        .pipe(Effect.mapError((cause) => new ToolExecutionError({ operation: "cache", cause })));
      return { db, kv, cache } as const;
    });
    return { acquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolPersistenceService, ToolPersistenceService.make);
}

export const toolPersistenceLayer = ToolPersistenceService.layer.pipe(
  Layer.provide(Layer.mergeAll(toolDatabaseLayer, toolKvLayer, toolCacheLayer)),
);
