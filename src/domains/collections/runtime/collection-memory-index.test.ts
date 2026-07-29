import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { CollectionIndexInterface } from "../types/tool-collection";
import {
  CollectionHandleFactoryService,
  collectionHandleFactoryLayer,
} from "./collection-handle-factory";
import { MemoryCollectionIndexService } from "./fixtures/memory-collection-index";

const makeMemoryIndex = (): CollectionIndexInterface =>
  Effect.runSync(
    MemoryCollectionIndexService.use((service) => service.create).pipe(
      Effect.provide(MemoryCollectionIndexService.layer),
    ),
  );

describe("collection memory index", () => {
  it("filters, sorts, and searches rows across fallback values", () => {
    const index = makeMemoryIndex();
    index.upsertDoc(
      {
        id: "two",
        data: { meta: { state: { open: false } } },
        body: "alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      1,
    );
    index.upsertDoc(
      {
        id: "one",
        data: { meta: { state: { open: true } }, rank: 1 },
        body: "alpha beta",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      1,
    );
    index.upsertDoc(
      {
        id: "three",
        data: { meta: { state: { open: true } }, rank: 1 },
        body: "gamma",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      1,
    );

    expect(index.listDocs({ where: { "meta.state": { open: true } } }).total).toBe(2);
    expect(index.listDocs({ sort: "rank" }).rows.map((row) => row.id)).toEqual([
      "two",
      "one",
      "three",
    ]);
    expect(index.listDocs({ sort: "-rank" }).rows.map((row) => row.id)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(index.listDocs({}).rows.map((row) => row.id)).toEqual(["three", "one", "two"]);
    expect(index.searchDocs("alpha beta", 5).map((row) => row.id)).toEqual(["one", "two"]);

    const reverseIndex = makeMemoryIndex();
    reverseIndex.upsertDoc(
      {
        id: "ranked",
        data: { rank: 1 },
        body: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      1,
    );
    reverseIndex.upsertDoc(
      {
        id: "missing",
        data: {},
        body: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      1,
    );
    expect(reverseIndex.listDocs({ sort: "rank" }).total).toBe(2);
    expect(reverseIndex.listDocs({}).rows.map((row) => row.id)).toEqual(["ranked", "missing"]);
  });

  it("falls back to filesystem timestamps when an entry is absent from the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rig-collection-fallback-"));
    const index = makeMemoryIndex();
    const handle = await Effect.runPromise(
      CollectionHandleFactoryService.use((service) =>
        service.createLazy("notes", dir, {}, index),
      ).pipe(Effect.provide(collectionHandleFactoryLayer)),
    );
    try {
      await writeFile(join(dir, "manual.md"), "---\ntitle: Manual\n---\nBody", "utf8");
      await handle.count();
      index.deleteDoc("manual");
      const entry = await handle.getEntry("manual");
      expect(entry?.id).toBe("manual");
    } finally {
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
