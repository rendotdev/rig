import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import {
  CollectionHandleFactoryService,
  CollectionHandleInitializationService,
  CollectionHandleResourceService,
  LazyCollectionHandleService,
  collectionHandleFactoryLayer,
} from "./collection-handle-factory";
import type { CollectionIndexInterface, ManagedCollectionHandle } from "../types/tool-collection";
import { fileLockLayer } from "../../../providers/filesystem/file-lock";
import { RigError } from "../../../providers/errors/rig-error";
import { MemoryCollectionIndexService } from "./fixtures/memory-collection-index";

const makeMemoryIndex = (): CollectionIndexInterface =>
  Effect.runSync(
    MemoryCollectionIndexService.use((service) => service.create).pipe(
      Effect.provide(MemoryCollectionIndexService.layer),
    ),
  );

class TrackingMemoryCollectionIndex implements CollectionIndexInterface {
  openRuns = 0;
  closeRuns = 0;

  constructor(private readonly index = makeMemoryIndex()) {}

  open = () => {
    this.openRuns++;
    return this.index.open();
  };
  upsertDoc = (...args: Parameters<CollectionIndexInterface["upsertDoc"]>) =>
    this.index.upsertDoc(...args);
  deleteDoc = (id: string) => this.index.deleteDoc(id);
  upsertFile = (...args: Parameters<CollectionIndexInterface["upsertFile"]>) =>
    this.index.upsertFile(...args);
  deleteFile = (id: string) => this.index.deleteFile(id);
  getFile = (id: string) => this.index.getFile(id);
  allFileIds = () => this.index.allFileIds();
  getDoc = (id: string) => this.index.getDoc(id);
  listDocs = (...args: Parameters<CollectionIndexInterface["listDocs"]>) =>
    this.index.listDocs(...args);
  searchDocs = (...args: Parameters<CollectionIndexInterface["searchDocs"]>) =>
    this.index.searchDocs(...args);
  countDocs = (...args: Parameters<CollectionIndexInterface["countDocs"]>) =>
    this.index.countDocs(...args);
  allIds = () => this.index.allIds();
  clearAll = () => this.index.clearAll();
  close = () => {
    this.closeRuns++;
    this.index.close();
  };
}

describe("CollectionHandle reliability", () => {
  it("initializes and closes scoped handles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-collection-scoped-"));
    const index = new TrackingMemoryCollectionIndex();
    try {
      await Effect.runPromise(
        Effect.scoped(
          CollectionHandleFactoryService.use((service) =>
            service.acquire("notes", directory, {}, index),
          ),
        ).pipe(Effect.provide(collectionHandleFactoryLayer)),
      );

      expect(index.openRuns).toBe(1);
      expect(index.closeRuns).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes collection initialization failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-collection-failure-"));
    const initializationLayer = CollectionHandleInitializationService.layer.pipe(
      Layer.provide(fileLockLayer),
    );
    try {
      const errorIndex = makeMemoryIndex();
      errorIndex.open = () => Promise.reject(new Error("database unavailable"));
      const error = await Effect.runPromise(
        CollectionHandleInitializationService.use((service) =>
          service.initialize(directory, errorIndex, Effect.void),
        ).pipe(Effect.provide(initializationLayer), Effect.flip),
      );
      expect(error).toBeInstanceOf(RigError);
      expect(error.message).toBe("database unavailable");

      const stringIndex = makeMemoryIndex();
      stringIndex.open = () => Promise.reject("database unavailable as text");
      const stringError = await Effect.runPromise(
        CollectionHandleInitializationService.use((service) =>
          service.initialize(directory, stringIndex, Effect.void),
        ).pipe(Effect.provide(initializationLayer), Effect.flip),
      );
      expect(stringError).toBeInstanceOf(RigError);
      expect(stringError.message).toBe("database unavailable as text");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes raw scoped resource failures", async () => {
    const failures: readonly unknown[] = [
      new RigError({ code: "INTERNAL_ERROR", message: "typed failure" }),
      new Error("error failure"),
      "text failure",
    ];
    await Promise.all(
      failures.map(async (failure) => {
        const handle = {
          name: "notes",
          path: "/tmp/unused",
          init: () => Promise.reject(failure),
          close: () => undefined,
        } as ManagedCollectionHandle;
        const resourceLayer = Layer.succeed(CollectionHandleResourceService, {
          create: () => Effect.succeed(handle),
        });
        const factoryLayer = CollectionHandleFactoryService.layer.pipe(
          Layer.provide(Layer.merge(resourceLayer, LazyCollectionHandleService.layer)),
        );
        const received = await Effect.runPromise(
          Effect.scoped(
            CollectionHandleFactoryService.use((service) =>
              service.acquire("notes", "/tmp/unused", {}),
            ),
          ).pipe(Effect.provide(factoryLayer), Effect.flip),
        );
        expect(received).toBeInstanceOf(RigError);
        expect(received.message).toBe(failure instanceof Error ? failure.message : String(failure));
      }),
    );
  });
});
