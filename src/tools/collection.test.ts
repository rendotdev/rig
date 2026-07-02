import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CollectionHandleImpl } from "./collection";

const hasBunSqlite = typeof (globalThis as any).Bun !== "undefined";
const describeIfBun = hasBunSqlite ? describe : describe.skip;

describeIfBun("CollectionHandle", () => {
  let dir: string;
  let handle: CollectionHandleImpl<any>;

  const schema = z.object({
    ticket: z.string(),
    summary: z.string(),
    status: z.enum(["open", "in-progress", "done"]).default("open"),
    priority: z.number().optional(),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-test-"));
    handle = new CollectionHandleImpl("test-collection", dir, {
      schema,
      generateId: (data: any) => data.ticket,
    });
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
    handle = new CollectionHandleImpl("test-collection", dir, {
      schema,
      generateId: (data: any) => data.ticket,
    });
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

describeIfBun("CollectionHandle (schema-less)", () => {
  let dir: string;
  let handle: CollectionHandleImpl<any>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rig-collection-schemaless-"));
    handle = new CollectionHandleImpl("notes", dir, {});
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
