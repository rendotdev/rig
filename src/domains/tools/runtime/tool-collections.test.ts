import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import {
  CollectionHandleFactoryService,
  LazyCollectionHandleService,
} from "../../collections/runtime/collection-handle-factory";
import type {
  CollectionHandle,
  ManagedCollectionHandle,
} from "../../collections/types/tool-collection";
import { ToolCollectionsService } from "./tool-collections";
import { toolIdentifierLayer } from "../service/tool-identifier";

class FaultInjectingCollectionHandle implements ManagedCollectionHandle {
  readonly path = "/tmp/test";
  readonly calls: string[] = [];
  initialized = false;
  closeRuns = 0;

  constructor(
    readonly name: string,
    private readonly failure: Error | undefined,
  ) {}

  async init(): Promise<void> {
    if (this.failure) throw this.failure;
    this.initialized = true;
  }

  close(): void {
    this.closeRuns++;
  }

  async create(): Promise<never> {
    this.calls.push("create");
    return { id: "created" } as never;
  }
  async getEntry(): Promise<never> {
    this.calls.push("getEntry");
    return null as never;
  }
  async update(): Promise<never> {
    this.calls.push("update");
    return { id: "updated" } as never;
  }
  async upsert(): Promise<never> {
    this.calls.push("upsert");
    return { id: "upserted", created: true } as never;
  }
  async remove(): Promise<boolean> {
    this.calls.push("remove");
    return true;
  }
  async list(): Promise<never> {
    this.calls.push("list");
    return { entries: [], total: 0 } as never;
  }
  async search(): Promise<never> {
    this.calls.push("search");
    return { entries: [] } as never;
  }
  async count(): Promise<number> {
    this.calls.push("count");
    return 1;
  }
  async getCollection(): Promise<never> {
    this.calls.push("getCollection");
    return [] as never;
  }
  async clear(): Promise<void> {
    this.calls.push("clear");
  }
}

class FaultInjectingCollectionHandleFactory {
  readonly handles: FaultInjectingCollectionHandle[] = [];

  create(name: string): FaultInjectingCollectionHandle {
    const handle = new FaultInjectingCollectionHandle(
      name,
      name === "broken" ? new Error("collection initialization failed") : undefined,
    );
    this.handles.push(handle);
    return handle;
  }
}

describe("ToolCollections cleanup", () => {
  it("initializes collections on first use and closes failures", async () => {
    const factory = new FaultInjectingCollectionHandleFactory();
    const factoryLayer = Layer.effect(
      CollectionHandleFactoryService,
      Effect.gen(function* () {
        const lazyHandles = yield* LazyCollectionHandleService;
        return {
          createLazy: <T extends Record<string, unknown>>(name: string) =>
            lazyHandles.create<T>(factory.create(name)),
          acquire: <T extends Record<string, unknown>>(name: string) =>
            Effect.succeed(factory.create(name) as CollectionHandle<T>),
        } as const;
      }),
    ).pipe(Layer.provide(LazyCollectionHandleService.layer));
    const serviceLayer = ToolCollectionsService.layer.pipe(
      Layer.provide(Layer.merge(factoryLayer, toolIdentifierLayer)),
    );
    const handles = await Effect.runPromise(
      ToolCollectionsService.use((service) =>
        service.setup({
          path: "/tmp/tool/index.rig.ts",
          definition: { collections: { ready: {}, broken: {}, unused: undefined } },
        } as never),
      ).pipe(Effect.provide(serviceLayer)),
    );

    expect(factory.handles.every((handle) => !handle.initialized)).toBe(true);
    await expect(handles?.broken?.count()).rejects.toThrow("collection initialization failed");
    expect(factory.handles.find((handle) => handle.name === "broken")?.closeRuns).toBe(1);

    const ready = handles!.ready!;
    await ready.create({ data: {} });
    await ready.getEntry("created");
    await ready.update("created", { body: "updated" });
    await ready.upsert({ id: "upserted", data: {} });
    await ready.remove("created");
    await ready.list({ limit: 1 });
    await ready.search("query", { limit: 1 });
    expect(await ready.count({ status: "ready" })).toBe(1);
    await ready.getCollection(() => true);
    await ready.clear();

    expect(factory.handles.find((handle) => handle.name === "ready")?.calls).toEqual([
      "create",
      "getEntry",
      "update",
      "upsert",
      "remove",
      "list",
      "search",
      "count",
      "getCollection",
      "clear",
    ]);
    await Effect.runPromise(
      ToolCollectionsService.use((service) => service.close(handles)).pipe(
        Effect.provide(serviceLayer),
      ),
    );
    expect(
      factory.handles.map((handle) => [handle.name, handle.initialized, handle.closeRuns]),
    ).toEqual([
      ["ready", true, 1],
      ["broken", false, 1],
      ["unused", false, 0],
    ]);
  });

  it("returns undefined for tools without collections", async () => {
    const factoryLayer = Layer.succeed(CollectionHandleFactoryService, {
      createLazy: () => Effect.die("unexpected collection"),
      acquire: () => Effect.die("unexpected collection"),
    });
    const serviceLayer = ToolCollectionsService.layer.pipe(
      Layer.provide(Layer.merge(factoryLayer, toolIdentifierLayer)),
    );
    expect(
      await Effect.runPromise(
        ToolCollectionsService.use((service) =>
          service.setup({ path: "/tmp/tool/index.rig.ts", definition: {} } as never),
        ).pipe(Effect.provide(serviceLayer)),
      ),
    ).toBeUndefined();
    await Effect.runPromise(
      ToolCollectionsService.use((service) => service.close(undefined)).pipe(
        Effect.provide(serviceLayer),
      ),
    );
  });
});
