import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { z } from "zod";
import {
  CollectionHandleFactoryService,
  collectionHandleFactoryLayer,
} from "./collection-handle-factory";
import type {
  CollectionDefinition,
  CollectionHandle,
  CollectionIndexInterface,
} from "../types/tool-collection";
import { MemoryCollectionIndexService } from "./fixtures/memory-collection-index";

type ClosableCollectionHandle<T = Record<string, unknown>> = CollectionHandle<T> & {
  close(): void;
};

const makeMemoryIndex = (): CollectionIndexInterface =>
  Effect.runSync(
    MemoryCollectionIndexService.use((service) => service.create).pipe(
      Effect.provide(MemoryCollectionIndexService.layer),
    ),
  );

const makeCollectionHandle = <T extends Record<string, unknown>>(
  name: string,
  path: string,
  definition: CollectionDefinition = {},
  index: CollectionIndexInterface = makeMemoryIndex(),
): Promise<ClosableCollectionHandle<T>> =>
  Effect.runPromise(
    CollectionHandleFactoryService.use((service) =>
      service.createLazy<T>(name, path, definition, index),
    ).pipe(Effect.provide(collectionHandleFactoryLayer)),
  );

class TrackingMemoryCollectionIndex implements CollectionIndexInterface {
  upsertCalls = 0;

  constructor(private readonly index = makeMemoryIndex()) {}

  upsertDoc(...args: Parameters<CollectionIndexInterface["upsertDoc"]>): void {
    this.upsertCalls++;
    this.index.upsertDoc(...args);
  }

  open = () => this.index.open();
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
  close = () => this.index.close();
}

describe("CollectionHandle", () => {
  let dir: string;
  let handle: ClosableCollectionHandle<any>;

  const schema = z.object({
    ticket: z.string(),
    summary: z.string(),
    status: z.enum(["open", "in-progress", "done"]).default("open"),
    priority: z.number().optional(),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-test-"));
    handle = await makeCollectionHandle(
      "test-collection",
      dir,
      { schema, generateId: (data: any) => data.ticket },
      makeMemoryIndex(),
    );
    await handle.count();
  });

  afterEach(async () => {
    handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates an entry and reads it back", async () => {
    const entry = await handle.create({
      data: { ticket: "CONSOLE-100", summary: "Fix bug", status: "open" },
      body: "## Notes\nSome content",
    });

    expect(entry.id).toBe("CONSOLE-100");
    expect(entry.data.ticket).toBe("CONSOLE-100");
    expect(entry.data.summary).toBe("Fix bug");
    expect(entry.body).toBe("## Notes\nSome content");

    const fetched = await handle.getEntry("CONSOLE-100");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("CONSOLE-100");
    expect(fetched!.data.summary).toBe("Fix bug");
  });

  it("uses generateId from data", async () => {
    const entry = await handle.create({
      data: { ticket: "CONSOLE-200", summary: "Another bug", status: "open" },
    });
    expect(entry.id).toBe("CONSOLE-200");
  });

  it("allows explicit id override", async () => {
    const entry = await handle.create({
      id: "custom-id",
      data: { ticket: "CONSOLE-300", summary: "Custom", status: "open" },
    });
    expect(entry.id).toBe("custom-id");
  });

  it("rejects entry ids that could escape the collection", async () => {
    const invalidIds = ["", ".", "..", "../escaped", "/tmp/escaped", "nested/id", "nested\\id"];
    const outsidePath = join(dir, "..", "escaped.md");

    await Promise.all(
      invalidIds.map(async (id) => {
        await expect(
          handle.create({
            id,
            data: { ticket: "SAFE-1", summary: "Unsafe id", status: "open" },
          }),
        ).rejects.toThrow("Invalid collection entry id");
        await expect(handle.getEntry(id)).rejects.toThrow("Invalid collection entry id");
        await expect(handle.update(id, { body: "unsafe" })).rejects.toThrow(
          "Invalid collection entry id",
        );
        await expect(
          handle.upsert({
            id,
            data: { ticket: "SAFE-1", summary: "Unsafe id", status: "open" },
          }),
        ).rejects.toThrow("Invalid collection entry id");
        await expect(handle.remove(id)).rejects.toThrow("Invalid collection entry id");
      }),
    );

    expect(existsSync(outsidePath)).toBe(false);
  });

  it("validates ids returned by generateId", async () => {
    await expect(
      handle.create({
        data: { ticket: "../generated-escape", summary: "Unsafe generated id", status: "open" },
      }),
    ).rejects.toThrow("Invalid collection entry id");
  });

  it("throws on duplicate create", async () => {
    await handle.create({
      data: { ticket: "CONSOLE-100", summary: "First", status: "open" },
    });
    await expect(
      handle.create({
        data: { ticket: "CONSOLE-100", summary: "Duplicate", status: "open" },
      }),
    ).rejects.toThrow("already exists");
  });

  it("validates data against schema", async () => {
    await expect(
      handle.create({
        id: "bad",
        data: { ticket: 123, summary: "Bad" } as any,
      }),
    ).rejects.toThrow("invalid");
  });

  it("updates entry data (merge) and body", async () => {
    await handle.create({
      data: { ticket: "CONSOLE-100", summary: "Original", status: "open", priority: 1 },
      body: "Original body",
    });

    const updated = await handle.update("CONSOLE-100", {
      data: { status: "done" },
      body: "Updated body",
    });

    expect(updated.data.status).toBe("done");
    expect(updated.data.summary).toBe("Original");
    expect(updated.data.priority).toBe(1);
    expect(updated.body).toBe("Updated body");
  });

  it("removes an entry", async () => {
    await handle.create({
      data: { ticket: "CONSOLE-100", summary: "To delete", status: "open" },
    });

    const removed = await handle.remove("CONSOLE-100");
    expect(removed).toBe(true);

    const fetched = await handle.getEntry("CONSOLE-100");
    expect(fetched).toBeNull();
  });

  it("remove returns false for non-existent", async () => {
    const removed = await handle.remove("non-existent");
    expect(removed).toBe(false);
  });

  it("upserts: creates if missing, updates if exists", async () => {
    const r1 = await handle.upsert({
      id: "CONSOLE-100",
      data: { ticket: "CONSOLE-100", summary: "Created", status: "open" },
    });
    expect(r1.created).toBe(true);

    const r2 = await handle.upsert({
      id: "CONSOLE-100",
      data: { ticket: "CONSOLE-100", summary: "Updated", status: "done" },
    });
    expect(r2.created).toBe(false);

    const entry = await handle.getEntry("CONSOLE-100");
    expect(entry!.data.summary).toBe("Updated");
    expect(entry!.data.status).toBe("done");
  });

  it("lists entries with where filter", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open" } });
    await handle.create({ data: { ticket: "A-2", summary: "Two", status: "done" } });
    await handle.create({ data: { ticket: "A-3", summary: "Three", status: "open" } });

    const { entries, total } = await handle.list({ where: { status: "open" } });
    expect(total).toBe(2);
    expect(entries.map((e) => e.id).toSorted()).toEqual(["A-1", "A-3"]);
  });

  it("lists entries with sort", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open", priority: 3 } });
    await handle.create({ data: { ticket: "A-2", summary: "Two", status: "open", priority: 1 } });
    await handle.create({ data: { ticket: "A-3", summary: "Three", status: "open", priority: 2 } });

    const { entries } = await handle.list({ sort: "priority" });
    expect(entries.map((e) => e.id)).toEqual(["A-2", "A-3", "A-1"]);
  });

  it("filters and sorts using valid nested field paths", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({ id: "a", data: { project: { state: "open", priority: 2 } } });
    await handle.create({ id: "b", data: { project: { state: "done", priority: 1 } } });
    await handle.create({ id: "c", data: { project: { state: "open", priority: 3 } } });

    const { entries, total } = await handle.list({
      where: { "project.state": "open" },
      sort: "-project.priority",
    });

    expect(total).toBe(2);
    expect(entries.map((entry) => entry.id)).toEqual(["c", "a"]);
    expect(await handle.count({ "project.state": "open" })).toBe(2);
  });

  it("rejects malformed where and sort field paths", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open" } });

    await expect(handle.list({ where: { "status') OR 1=1 --": "open" } })).rejects.toThrow(
      "Invalid collection field path",
    );
    await expect(handle.list({ sort: "status; DELETE FROM docs" })).rejects.toThrow(
      "Invalid collection field path",
    );
    await expect(handle.count({ "project..status": "open" })).rejects.toThrow(
      "Invalid collection field path",
    );
  });

  it("searches entries via FTS", async () => {
    await handle.create({
      data: { ticket: "A-1", summary: "Payment retry", status: "open" },
      body: "The payment retry logic has a bug in the exponential backoff.",
    });
    await handle.create({
      data: { ticket: "A-2", summary: "UI alignment", status: "open" },
      body: "The button is misaligned on mobile.",
    });

    const { entries } = await handle.search("payment retry");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.id).toBe("A-1");
    expect(entries[0]!.snippet).toBeTruthy();
  });

  it("counts entries", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open" } });
    await handle.create({ data: { ticket: "A-2", summary: "Two", status: "done" } });

    expect(await handle.count()).toBe(2);
    expect(await handle.count({ status: "open" })).toBe(1);
  });

  it("getCollection with filter", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open" } });
    await handle.create({ data: { ticket: "A-2", summary: "Two", status: "done" } });

    const all = await handle.getCollection();
    expect(all.length).toBe(2);

    const open = await handle.getCollection((e) => e.data.status === "open");
    expect(open.length).toBe(1);
    expect(open[0]!.id).toBe("A-1");
  });

  it("reconciles hand-edited files on next init", async () => {
    await handle.create({
      data: { ticket: "A-1", summary: "Original", status: "open" },
      body: "Original body",
    });
    handle.close();

    const filePath = join(dir, "A-1.md");
    await writeFile(
      filePath,
      "---\nticket: A-1\nsummary: Hand-edited\nstatus: done\n---\n\nEdited by hand\n",
    );

    handle = await makeCollectionHandle(
      "test-collection",
      dir,
      { schema, generateId: (data: any) => data.ticket },
      makeMemoryIndex(),
    );
    await handle.count();

    const entry = await handle.getEntry("A-1");
    expect(entry!.data.summary).toBe("Hand-edited");
    expect(entry!.data.status).toBe("done");
    expect(entry!.body).toBe("Edited by hand\n");
  });

  it("clears all entries", async () => {
    await handle.create({ data: { ticket: "A-1", summary: "One", status: "open" } });
    await handle.create({ data: { ticket: "A-2", summary: "Two", status: "open" } });

    await handle.clear();
    expect(await handle.count()).toBe(0);
    expect(await handle.getEntry("A-1")).toBeNull();
  });
});

describe("CollectionHandle edge cases", () => {
  let dir: string;
  let handle: ClosableCollectionHandle<any>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-edge-"));
  });

  afterEach(async () => {
    handle?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("derives id from common fields when no generateId", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    const entry = await handle.create({
      data: { title: "My Great Note", content: "hello" },
    });
    expect(entry.id).toBe("my-great-note");
  });

  it("derives id from slug field", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    const entry = await handle.create({
      data: { slug: "custom-slug", content: "hello" },
    });
    expect(entry.id).toBe("custom-slug");
  });

  it("derives id from id field", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    const entry = await handle.create({
      data: { id: "my-id", content: "hello" },
    });
    expect(entry.id).toBe("my-id");
  });

  it("throws when no id can be derived", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await expect(handle.create({ data: { count: 42 } })).rejects.toThrow("needs an id");
  });

  it("throws on update of non-existent entry", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await expect(handle.update("ghost", { data: { x: 1 } })).rejects.toThrow("not found");
  });

  it("handles complex frontmatter with nested objects and arrays", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({
      id: "complex",
      data: {
        title: "Complex entry",
        tags: ["a", "b", "c"],
        prs: [
          { number: 123, url: "https://example.com", state: "OPEN" },
          { number: 456, url: "https://example.com/2", state: "MERGED" },
        ],
        nested: { foo: "bar", baz: 42 },
        empty_arr: [],
        flag: true,
        nothing: null,
        priority: 3,
      },
      body: "## Content\nWith special chars: {foo} [bar] *baz*",
    });

    const fetched = await handle.getEntry("complex");
    expect(fetched!.data.title).toBe("Complex entry");
    expect(fetched!.data.tags).toEqual(["a", "b", "c"]);
    expect(fetched!.data.prs).toHaveLength(2);
    expect(fetched!.data.prs[0].number).toBe(123);
    expect(fetched!.data.nested.foo).toBe("bar");
    expect(fetched!.data.empty_arr).toEqual([]);
    expect(fetched!.data.flag).toBe(true);
    expect(fetched!.data.nothing).toBeNull();
    expect(fetched!.data.priority).toBe(3);
  });

  it("handles frontmatter with quoted strings and special values", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({
      id: "special",
      data: {
        url: "https://example.com/path?q=1&b=2",
        description: "Has: colon in value",
      },
      body: "",
    });
    const fetched = await handle.getEntry("special");
    expect(fetched!.data.url).toBe("https://example.com/path?q=1&b=2");
    expect(fetched!.data.description).toBe("Has: colon in value");
  });

  it("update with only body preserves data", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({ id: "note1", data: { title: "Original" }, body: "old" });
    const updated = await handle.update("note1", { body: "new body" });
    expect(updated.data.title).toBe("Original");
    expect(updated.body).toBe("new body");
  });

  it("list with offset and descending sort", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({ id: "a", data: { title: "A", rank: 1 } });
    await handle.create({ id: "b", data: { title: "B", rank: 2 } });
    await handle.create({ id: "c", data: { title: "C", rank: 3 } });

    const { entries } = await handle.list({ sort: "-rank", limit: 2, offset: 1 });
    expect(entries.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("search returns fallback snippet when no line matches", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({
      id: "note1",
      data: { title: "searchable" },
      body: "This body has no matching words for the search term.",
    });
    // The memory index matches on title in data_json
    const { entries } = await handle.search("searchable");
    expect(entries.length).toBe(1);
    expect(entries[0]!.snippet).toBeTruthy();
  });

  it("reconcile removes index entries for deleted files", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
    await handle.create({ id: "keep", data: { title: "Keep" } });
    await handle.create({ id: "delete-me", data: { title: "Delete" } });
    handle.close();

    // Delete the file manually
    const { unlink: unlinkFile } = await import("node:fs/promises");
    await unlinkFile(join(dir, "delete-me.md"));

    // Re-init with fresh index
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();

    expect(await handle.getEntry("keep")).not.toBeNull();
    // delete-me.md is gone, so getEntry reads from disk and fails
    expect(await handle.getEntry("delete-me")).toBeNull();
  });

  it("handles content without frontmatter", async () => {
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();

    // Write a raw file without frontmatter
    await writeFile(join(dir, "raw.md"), "Just plain content\n");

    // Re-init to trigger reconcile
    handle.close();
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();

    const entry = await handle.getEntry("raw");
    expect(entry!.data).toEqual({});
    expect(entry!.body).toBe("Just plain content\n");
  });

  it("uses the fingerprint fast path for unchanged files", async () => {
    const index = new TrackingMemoryCollectionIndex();
    handle = await makeCollectionHandle("notes", dir, {}, index);
    await handle.count();
    await handle.create({ id: "stable", data: { title: "Stable" }, body: "unchanged" });
    expect(index.upsertCalls).toBe(1);
    handle.close();

    handle = await makeCollectionHandle("notes", dir, {}, index);
    await handle.count();

    expect(index.upsertCalls).toBe(1);
    expect((await handle.list()).entries).toHaveLength(1);
  });
});

describe("CollectionHandle (schema-less)", () => {
  let dir: string;
  let handle: ClosableCollectionHandle<any>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-schemaless-"));
    handle = await makeCollectionHandle("notes", dir, {});
    await handle.count();
  });

  afterEach(async () => {
    handle.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates and reads without schema validation", async () => {
    const entry = await handle.create({
      id: "my-note",
      data: { anything: "goes", nested: { foo: "bar" } },
      body: "Free-form content",
    });

    expect(entry.id).toBe("my-note");
    const fetched = await handle.getEntry("my-note");
    expect(fetched!.data.anything).toBe("goes");
  });

  it("searches schema-less entries", async () => {
    await handle.create({
      id: "note-1",
      data: { topic: "deployment" },
      body: "We deployed the new service to production today.",
    });

    const { entries } = await handle.search("deployed production");
    expect(entries.length).toBe(1);
  });
});
