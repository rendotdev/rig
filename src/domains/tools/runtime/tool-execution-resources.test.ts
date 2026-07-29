/** @effect-diagnostics strictEffectProvide:skip-file */
/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns these Effect-aware tests. */
import { it } from "@effect/vitest";
import { Effect, Layer, Result, Scope } from "effect";
import { expect } from "vite-plus/test";
import { ToolCollectionsService } from "./tool-collections";
import type { CollectionHandle } from "../../collections/types/tool-collection";
import {
  ToolPersistenceService,
  type ToolPersistenceResourceSet,
} from "../service/tool-persistence";
import { RigError } from "../../../providers/errors/rig-error";
import type { LoadedTool, RigToolDatabase, RigToolLogger } from "../types/tool-types";
import { ToolExecutionError, type ToolExecutionOperation } from "../types/tool-execution";
import { ToolExecutionResourcesService } from "./tool-execution-resources";

class ResourceHarness {
  readonly events: string[] = [];
  readonly cause = new RigError({ code: "INTERNAL_ERROR", message: "resource setup failed" });
  readonly tool = {} as LoadedTool;
  readonly log = {} as RigToolLogger;
  readonly db = {} as RigToolDatabase;
  readonly kv = {} as ToolPersistenceResourceSet["kv"];
  readonly cache = {} as ToolPersistenceResourceSet["cache"];
  readonly collections = {} as Record<string, CollectionHandle<any>>;

  constructor(
    private readonly setupFailure?: ToolExecutionOperation,
    private readonly closeFailure?: ToolExecutionOperation,
  ) {}

  layer() {
    const acquireDatabase = () => this.acquire("database", this.db);
    const acquireKv = () => this.acquire("kv", this.kv);
    const acquireCache = () => this.acquire("cache", this.cache);
    const persistence = Layer.succeed(ToolPersistenceService, {
      acquire: () =>
        Effect.gen(function* () {
          const db = yield* acquireDatabase().pipe(
            Effect.mapError((cause) => new ToolExecutionError({ operation: "database", cause })),
          );
          const kv = yield* acquireKv().pipe(
            Effect.mapError((cause) => new ToolExecutionError({ operation: "kv", cause })),
          );
          const cache = yield* acquireCache().pipe(
            Effect.mapError((cause) => new ToolExecutionError({ operation: "cache", cause })),
          );
          return { db, kv, cache } as const;
        }),
    });
    const collections = Layer.succeed(ToolCollectionsService, {
      setup: () => Effect.succeed(this.collections),
      acquire: () => this.acquire("collections", this.collections),
      close: () => Effect.void,
    });
    return ToolExecutionResourcesService.layer.pipe(
      Layer.provide(Layer.merge(persistence, collections)),
    );
  }

  private acquire<Resource>(
    operation: ToolExecutionOperation,
    resource: Resource,
  ): Effect.Effect<Resource, RigError, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.try({
        try: () => {
          this.events.push(`open:${operation}`);
          if (operation === this.setupFailure) throw this.cause;
          return resource;
        },
        catch: (cause) =>
          cause instanceof RigError
            ? cause
            : new RigError({ code: "INTERNAL_ERROR", message: String(cause), details: cause }),
      }),
      () =>
        Effect.sync(() => {
          this.events.push(`close:${operation}`);
          if (operation === this.closeFailure) this.events.push(`warn:${operation}`);
        }),
    );
  }
}

it.effect("releases every tool resource in reverse order", () =>
  Effect.gen(function* () {
    const harness = new ResourceHarness(undefined, "collections");
    const resources = yield* Effect.scoped(
      ToolExecutionResourcesService.use((service) =>
        service.acquire({ tool: harness.tool, log: harness.log }),
      ).pipe(Effect.provide(harness.layer())),
    );
    expect(resources).toEqual({
      db: harness.db,
      kv: harness.kv,
      cache: harness.cache,
      collections: harness.collections,
    });
    expect(harness.events).toEqual([
      "open:database",
      "open:kv",
      "open:cache",
      "open:collections",
      "close:collections",
      "warn:collections",
      "close:cache",
      "close:kv",
      "close:database",
    ]);
  }),
);

it.effect("releases partial setup and reports the failed operation", () =>
  Effect.gen(function* () {
    const harness = new ResourceHarness("cache");
    const result = yield* Effect.scoped(
      ToolExecutionResourcesService.use((service) =>
        service.acquire({ tool: harness.tool, log: harness.log }),
      ).pipe(Effect.provide(harness.layer()), Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(ToolExecutionError);
    expect(result.failure).toMatchObject({ operation: "cache", cause: harness.cause });
    expect(harness.events).toEqual([
      "open:database",
      "open:kv",
      "open:cache",
      "close:kv",
      "close:database",
    ]);
  }),
);
