/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns these Effect-aware tests. */
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect } from "vite-plus/test";
import type { ManagedRigToolCache } from "../cache";
import type { ManagedRigToolKvStore } from "../kv";
import type { LoadedTool, RigToolDatabase, RigToolLogger } from "../types";
import {
  ToolExecutionError,
  type ToolExecutionOperation,
  ToolExecutionResources,
} from "./tool-execution-resources";

class ResourceHarnessClass {
  readonly events: string[] = [];
  readonly cause = new Error("resource setup failed");
  readonly tool = {} as LoadedTool;
  readonly log = {
    warn: (bindings: Record<string, unknown>) => {
      this.events.push(`warn:${String(bindings.operation)}`);
    },
  } as RigToolLogger;
  readonly db = {} as RigToolDatabase;
  readonly kv = {} as ManagedRigToolKvStore;
  readonly cache = {} as ManagedRigToolCache;
  readonly collections = {};

  constructor(
    private readonly setupFailure?: ToolExecutionOperation,
    private readonly closeFailure?: ToolExecutionOperation,
  ) {}

  layer() {
    return ToolExecutionResources.makeLayer({
      setupDatabase: () => this.open("database", this.db),
      closeDatabase: () => this.close("database"),
      setupKv: () => this.open("kv", this.kv),
      closeKv: () => this.close("kv"),
      setupCache: () => this.open("cache", this.cache),
      closeCache: () => this.close("cache"),
      setupCollections: () => this.open("collections", this.collections),
      closeCollections: () => this.close("collections"),
    });
  }

  private async open<Resource>(
    operation: ToolExecutionOperation,
    resource: Resource,
  ): Promise<Resource> {
    this.events.push(`open:${operation}`);
    if (operation === this.setupFailure) throw this.cause;
    return resource;
  }

  private close(operation: ToolExecutionOperation): void {
    this.events.push(`close:${operation}`);
    if (operation === this.closeFailure) throw new Error("cleanup failed");
  }
}

it.effect("releases every tool resource in reverse order when cleanup throws", () =>
  Effect.gen(function* () {
    const harness = new ResourceHarnessClass(undefined, "collections");
    const resources = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ToolExecutionResources;
        return yield* service.acquire({ tool: harness.tool, log: harness.log });
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(harness.layer()),
      ),
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
    const harness = new ResourceHarnessClass("cache");
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ToolExecutionResources;
        return yield* service.acquire({ tool: harness.tool, log: harness.log });
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(harness.layer()),
        Effect.result,
      ),
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
