import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  CollectionHandleImplClass,
  FrontmatterCodecClass,
  ToolCollectionServiceClass,
  type CollectionHandleFactory,
  type ManagedCollectionHandle,
} from "./collection";
import { MemoryCollectionIndexClass } from "./collection-memory-index";

class BunCollectionIntegrationRunner {
  async run(collectionPath: string, body: string): Promise<Record<string, unknown>> {
    const scriptPath = join(collectionPath, `integration-${randomUUID()}.ts`);
    const collectionModule = pathToFileURL(join(process.cwd(), "src/tools/collection.ts")).href;
    const zodModule = pathToFileURL(join(process.cwd(), "node_modules/zod/index.js")).href;
    await writeFile(
      scriptPath,
      `import { Database } from "bun:sqlite";
import { stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollectionHandleImplClass } from ${JSON.stringify(collectionModule)};
import { z } from ${JSON.stringify(zodModule)};

const dir = ${JSON.stringify(collectionPath)};
${body}
`,
      "utf8",
    );
    const result = spawnSync("bun", [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, RIG_LOG: "0" },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  }
}

class TrackingMemoryCollectionIndex extends MemoryCollectionIndexClass {
  upsertCalls = 0;

  override upsertDoc(...args: Parameters<MemoryCollectionIndexClass["upsertDoc"]>): void {
    this.upsertCalls++;
    super.upsertDoc(...args);
  }
}

describe("CollectionHandle", () => {
  let dir: string;
  let handle: CollectionHandleImplClass<any>;

  const schema = z.object({
    ticket: z.string(),
    summary: z.string(),
    status: z.enum(["open", "in-progress", "done"]).default("open"),
    priority: z.number().optional(),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-test-"));
    handle = new CollectionHandleImplClass(
      "test-collection",
      dir,
      { schema, generateId: (data: any) => data.ticket },
      new MemoryCollectionIndexClass(),
    );
    await handle.init();
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
    expect(updated.data.summary).toBe("Original"); // preserved
    expect(updated.data.priority).toBe(1); // preserved
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
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
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

    // Hand-edit the file
    const filePath = join(dir, "A-1.md");
    await writeFile(
      filePath,
      "---\nticket: A-1\nsummary: Hand-edited\nstatus: done\n---\n\nEdited by hand\n",
    );

    // Re-init
    handle = new CollectionHandleImplClass(
      "test-collection",
      dir,
      { schema, generateId: (data: any) => data.ticket },
      new MemoryCollectionIndexClass(),
    );
    await handle.init();

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
  let handle: CollectionHandleImplClass<any>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-edge-"));
  });

  afterEach(async () => {
    handle?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("derives id from common fields when no generateId", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    const entry = await handle.create({
      data: { title: "My Great Note", content: "hello" },
    });
    expect(entry.id).toBe("my-great-note");
  });

  it("derives id from slug field", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    const entry = await handle.create({
      data: { slug: "custom-slug", content: "hello" },
    });
    expect(entry.id).toBe("custom-slug");
  });

  it("derives id from id field", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    const entry = await handle.create({
      data: { id: "my-id", content: "hello" },
    });
    expect(entry.id).toBe("my-id");
  });

  it("throws when no id can be derived", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    await expect(handle.create({ data: { count: 42 } })).rejects.toThrow("needs an id");
  });

  it("throws on update of non-existent entry", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    await expect(handle.update("ghost", { data: { x: 1 } })).rejects.toThrow("not found");
  });

  it("handles complex frontmatter with nested objects and arrays", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
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
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
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
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    await handle.create({ id: "note1", data: { title: "Original" }, body: "old" });
    const updated = await handle.update("note1", { body: "new body" });
    expect(updated.data.title).toBe("Original");
    expect(updated.body).toBe("new body");
  });

  it("list with offset and descending sort", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    await handle.create({ id: "a", data: { title: "A", rank: 1 } });
    await handle.create({ id: "b", data: { title: "B", rank: 2 } });
    await handle.create({ id: "c", data: { title: "C", rank: 3 } });

    const { entries } = await handle.list({ sort: "-rank", limit: 2, offset: 1 });
    expect(entries.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("search returns fallback snippet when no line matches", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
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
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
    await handle.create({ id: "keep", data: { title: "Keep" } });
    await handle.create({ id: "delete-me", data: { title: "Delete" } });
    handle.close();

    // Delete the file manually
    const { unlink: unlinkFile } = await import("node:fs/promises");
    await unlinkFile(join(dir, "delete-me.md"));

    // Re-init with fresh index
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();

    expect(await handle.getEntry("keep")).not.toBeNull();
    // delete-me.md is gone, so getEntry reads from disk and fails
    expect(await handle.getEntry("delete-me")).toBeNull();
  });

  it("handles content without frontmatter", async () => {
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();

    // Write a raw file without frontmatter
    await writeFile(join(dir, "raw.md"), "Just plain content\n");

    // Re-init to trigger reconcile
    handle.close();
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();

    const entry = await handle.getEntry("raw");
    expect(entry!.data).toEqual({});
    expect(entry!.body).toBe("Just plain content\n");
  });

  it("uses the fingerprint fast path for unchanged files", async () => {
    const index = new TrackingMemoryCollectionIndex();
    handle = new CollectionHandleImplClass("notes", dir, {}, index);
    await handle.init();
    await handle.create({ id: "stable", data: { title: "Stable" }, body: "unchanged" });
    expect(index.upsertCalls).toBe(1);
    handle.close();

    handle = new CollectionHandleImplClass("notes", dir, {}, index);
    await handle.init();

    expect(index.upsertCalls).toBe(1);
    expect((await handle.list()).entries).toHaveLength(1);
  });
});

describe("CollectionHandle (schema-less)", () => {
  let dir: string;
  let handle: CollectionHandleImplClass<any>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-schemaless-"));
    handle = new CollectionHandleImplClass("notes", dir, {}, new MemoryCollectionIndexClass());
    await handle.init();
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

describe("CollectionHandle real Bun SQLite reconciliation", () => {
  const runner = new BunCollectionIntegrationRunner();

  it("filters and sorts nested paths through SQLite without interpolating unsafe paths", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-query-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
await handle.create({ id: "a", data: { project: { state: "open", priority: 2 } } });
await handle.create({ id: "b", data: { project: { state: "done", priority: 1 } } });
await handle.create({ id: "c", data: { project: { state: "open", priority: 3 } } });
const listed = await handle.list({ where: { "project.state": "open" }, sort: "-project.priority" });
const count = await handle.count({ "project.state": "open" });
let invalidMessage = "";
try {
  await handle.list({ where: { "state') OR 1=1 --": "open" } });
} catch (error) {
  invalidMessage = error instanceof Error ? error.message : String(error);
}
handle.close();
console.log(JSON.stringify({ ids: listed.entries.map((entry) => entry.id), count, invalidMessage }));`,
      );

      expect(result).toEqual({
        ids: ["c", "a"],
        count: 2,
        invalidMessage: "Invalid collection field path: state') OR 1=1 --",
      });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });

  it("detects same-size hand edits even when mtime is restored", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-edit-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const filePath = join(dir, "note.md");
const original = "---\\ntitle: one\\n---\\n\\nbody one\\n";
const edited = "---\\ntitle: two\\n---\\n\\nbody two\\n";
await writeFile(filePath, original);
const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
await utimes(filePath, fixedTime, fixedTime);
let handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
handle.close();
const before = await stat(filePath);
await Bun.sleep(10);
await writeFile(filePath, edited);
await utimes(filePath, before.atime, before.mtime);
const after = await stat(filePath);
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
const listed = await handle.list();
handle.close();
console.log(JSON.stringify({ entry: listed.entries[0], sameMtime: before.mtimeMs === after.mtimeMs, sameSize: before.size === after.size, ctimeChanged: before.ctimeMs !== after.ctimeMs }));`,
      );

      expect(result).toMatchObject({
        entry: { data: { title: "two" }, body: "body two\n" },
        sameMtime: true,
        sameSize: true,
        ctimeChanged: true,
      });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });

  it("detects hand-added and hand-deleted files across reopen", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-files-"));
    try {
      const result = await runner.run(
        integrationDir,
        `let handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
handle.close();
const filePath = join(dir, "added.md");
await writeFile(filePath, "---\\ntitle: Added\\n---\\n\\nhello\\n");
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
const added = await handle.list();
handle.close();
await unlink(filePath);
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
const deleted = await handle.list();
handle.close();
console.log(JSON.stringify({ added: added.entries.map((entry) => entry.id), afterDelete: deleted.entries.map((entry) => entry.id) }));`,
      );

      expect(result).toEqual({ added: ["added"], afterDelete: [] });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });

  it("rebuilds corrupt and incompatible derived indexes from Markdown", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-recovery-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const indexPath = join(dir, ".index.sqlite");
let handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
await handle.create({ id: "durable", data: { title: "Markdown survives" }, body: "source of truth" });
handle.close();

await writeFile(indexPath, "corrupted sqlite\\n");
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
const afterCorruption = await handle.list();
handle.close();

await unlink(indexPath);
const incompatible = new Database(indexPath, { create: true, strict: true });
incompatible.run("CREATE TABLE docs (id TEXT PRIMARY KEY)");
incompatible.close(false);
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
const afterIncompatibleSchema = await handle.list();
handle.close();

const rebuilt = new Database(indexPath, { strict: true });
const integrity = rebuilt.query("PRAGMA quick_check").get();
rebuilt.close(false);
console.log(JSON.stringify({ afterCorruption, afterIncompatibleSchema, integrity }));`,
      );

      expect(result).toMatchObject({
        afterCorruption: {
          entries: [{ id: "durable", data: { title: "Markdown survives" } }],
          total: 1,
        },
        afterIncompatibleSchema: {
          entries: [{ id: "durable", data: { title: "Markdown survives" } }],
          total: 1,
        },
        integrity: { quick_check: "ok" },
      });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });

  it("removes malformed files from the index and fingerprints them as invalid", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-invalid-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const definition = { schema: z.object({ title: z.string() }) };
let handle = new CollectionHandleImplClass("notes", dir, definition);
await handle.init();
await handle.create({ id: "note", data: { title: "Valid" } });
handle.close();
await writeFile(join(dir, "note.md"), "---\\ntitle: 42\\n---\\n\\ninvalid\\n");
handle = new CollectionHandleImplClass("notes", dir, definition);
await handle.init();
const malformed = await handle.list();
handle.close();
const db = new Database(join(dir, ".index.sqlite"), { strict: true });
const record = db.query("SELECT status, size FROM collection_files WHERE id = ?").get("note");
db.close(false);
handle = new CollectionHandleImplClass("notes", dir, definition);
await handle.init();
const unchanged = await handle.list();
handle.close();
console.log(JSON.stringify({ malformedTotal: malformed.total, unchangedTotal: unchanged.total, record }));`,
      );

      expect(result).toMatchObject({
        malformedTotal: 0,
        unchangedTotal: 0,
        record: { status: "invalid" },
      });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });

  it("preserves persisted fingerprints on an unchanged reopen", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-fast-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const filePath = join(dir, "stable.md");
await writeFile(filePath, "---\\ntitle: Stable\\n---\\n\\nunchanged\\n");
let handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
handle.close();
let db = new Database(join(dir, ".index.sqlite"), { strict: true });
const before = db.query("SELECT * FROM collection_files WHERE id = ?").get("stable");
db.close(false);
handle = new CollectionHandleImplClass("notes", dir, {});
await handle.init();
handle.close();
db = new Database(join(dir, ".index.sqlite"), { strict: true });
const after = db.query("SELECT * FROM collection_files WHERE id = ?").get("stable");
db.close(false);
console.log(JSON.stringify({ before, after }));`,
      );

      expect(result.before).toEqual(result.after);
      expect(result.after).toMatchObject({ status: "indexed" });
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  });
});

class FaultInjectingCollectionHandleClass implements ManagedCollectionHandle {
  readonly path = "/tmp/test";
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

  create(): never {
    throw new Error("unused");
  }
  getEntry(): never {
    throw new Error("unused");
  }
  update(): never {
    throw new Error("unused");
  }
  upsert(): never {
    throw new Error("unused");
  }
  remove(): never {
    throw new Error("unused");
  }
  list(): never {
    throw new Error("unused");
  }
  search(): never {
    throw new Error("unused");
  }
  count(): never {
    throw new Error("unused");
  }
  getCollection(): never {
    throw new Error("unused");
  }
  clear(): never {
    throw new Error("unused");
  }
}

class FaultInjectingCollectionHandleFactoryClass implements CollectionHandleFactory {
  readonly handles: FaultInjectingCollectionHandleClass[] = [];

  create(name: string): FaultInjectingCollectionHandleClass {
    const handle = new FaultInjectingCollectionHandleClass(
      name,
      name === "broken" ? new Error("collection initialization failed") : undefined,
    );
    this.handles.push(handle);
    return handle;
  }
}

describe("ToolCollectionServiceClass cleanup", () => {
  it("closes the failing handle and initialized siblings after partial setup", async () => {
    const factory = new FaultInjectingCollectionHandleFactoryClass();
    const service = new ToolCollectionServiceClass(factory);

    await expect(
      service.setup({
        path: "/tmp/tool/index.rig.ts",
        definition: { collections: { ready: {}, broken: {}, alsoReady: {} } },
      } as never),
    ).rejects.toThrow("collection initialization failed");

    expect(
      factory.handles.map((handle) => [handle.name, handle.initialized, handle.closeRuns]),
    ).toEqual([
      ["ready", true, 1],
      ["broken", false, 1],
      ["alsoReady", true, 1],
    ]);
  });

  it("returns every initialized handle after successful setup", async () => {
    const factory = new FaultInjectingCollectionHandleFactoryClass();
    const service = new ToolCollectionServiceClass(factory);

    const handles = await service.setup({
      path: "/tmp/tool/index.rig.ts",
      definition: { collections: { ready: {}, optional: undefined } },
    } as never);

    expect(Object.keys(handles ?? {})).toEqual(["ready", "optional"]);
    service.close(handles);
    expect(factory.handles.every((handle) => handle.closeRuns === 1)).toBe(true);
  });
});

describe("collection codec and memory index edge cases", () => {
  it("parses scalar, object, and malformed YAML branches", () => {
    const codec = new FrontmatterCodecClass();
    const parsed = codec.parse(`---
mixed:
  nested: value
  - scalar
items:
  - name: first
    invalid continuation
invalid top-level line
enabled: false
empty: null
single: 'quoted'
---
Body`);

    expect(parsed).toMatchObject({
      data: {
        mixed: ["scalar"],
        items: [{ name: "first" }],
        enabled: false,
        empty: null,
        single: "quoted",
      },
      body: "Body",
    });
  });

  it("filters, sorts, and searches memory rows across fallback values", () => {
    const index = new MemoryCollectionIndexClass();
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

    const reverseIndex = new MemoryCollectionIndexClass();
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
    const index = new MemoryCollectionIndexClass();
    const handle = new CollectionHandleImplClass("notes", dir, {}, index);
    try {
      await writeFile(join(dir, "manual.md"), "---\ntitle: Manual\n---\nBody", "utf8");
      await handle.init();
      index.deleteDoc("manual");
      const entry = await (
        handle as unknown as { readFromDisk(id: string): Promise<{ id: string }> }
      ).readFromDisk("manual");
      expect(entry.id).toBe("manual");
    } finally {
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
