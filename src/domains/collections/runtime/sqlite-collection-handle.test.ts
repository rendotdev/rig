import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";

class BunCollectionIntegrationRunner {
  async run(collectionPath: string, body: string): Promise<Record<string, unknown>> {
    const scriptPath = join(collectionPath, `integration-${randomUUID()}.ts`);
    const collectionFactoryModule = pathToFileURL(
      join(process.cwd(), "src/domains/collections/runtime/collection-handle-factory.ts"),
    ).href;
    const effectModule = pathToFileURL(
      join(process.cwd(), "node_modules/effect/dist/index.js"),
    ).href;
    const zodModule = pathToFileURL(join(process.cwd(), "node_modules/zod/index.js")).href;
    await writeFile(
      scriptPath,
      `import { Database } from "bun:sqlite";
import { stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from ${JSON.stringify(effectModule)};
import { CollectionHandleFactoryService, collectionHandleFactoryLayer } from ${JSON.stringify(collectionFactoryModule)};
import { z } from ${JSON.stringify(zodModule)};

const dir = ${JSON.stringify(collectionPath)};
const makeHandle = (name, path, definition = {}) => Effect.runPromise(
  CollectionHandleFactoryService.use((service) => service.createLazy(name, path, definition)).pipe(
    Effect.provide(collectionHandleFactoryLayer),
  ),
);
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

describe("CollectionHandle real Bun SQLite reconciliation", () => {
  const runner = new BunCollectionIntegrationRunner();

  it("filters and sorts nested paths through SQLite without interpolating unsafe paths", async () => {
    const integrationDir = await mkdtemp(join(tmpdir(), "rig-collection-bun-query-"));
    try {
      const result = await runner.run(
        integrationDir,
        `const handle = await makeHandle("notes", dir, {});
await handle.count();
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
let handle = await makeHandle("notes", dir, {});
await handle.count();
handle.close();
const before = await stat(filePath);
await Bun.sleep(10);
await writeFile(filePath, edited);
await utimes(filePath, before.atime, before.mtime);
const after = await stat(filePath);
handle = await makeHandle("notes", dir, {});
await handle.count();
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
        `let handle = await makeHandle("notes", dir, {});
await handle.count();
handle.close();
const filePath = join(dir, "added.md");
await writeFile(filePath, "---\\ntitle: Added\\n---\\n\\nhello\\n");
handle = await makeHandle("notes", dir, {});
await handle.count();
const added = await handle.list();
handle.close();
await unlink(filePath);
handle = await makeHandle("notes", dir, {});
await handle.count();
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
let handle = await makeHandle("notes", dir, {});
await handle.count();
await handle.create({ id: "durable", data: { title: "Markdown survives" }, body: "source of truth" });
handle.close();

await writeFile(indexPath, "corrupted sqlite\\n");
handle = await makeHandle("notes", dir, {});
await handle.count();
const afterCorruption = await handle.list();
handle.close();

await unlink(indexPath);
const incompatible = new Database(indexPath, { create: true, strict: true });
incompatible.run("CREATE TABLE docs (id TEXT PRIMARY KEY)");
incompatible.close(false);
handle = await makeHandle("notes", dir, {});
await handle.count();
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
let handle = await makeHandle("notes", dir, definition);
await handle.count();
await handle.create({ id: "note", data: { title: "Valid" } });
handle.close();
await writeFile(join(dir, "note.md"), "---\\ntitle: 42\\n---\\n\\ninvalid\\n");
handle = await makeHandle("notes", dir, definition);
await handle.count();
const malformed = await handle.list();
handle.close();
const db = new Database(join(dir, ".index.sqlite"), { strict: true });
const record = db.query("SELECT status, size FROM collection_files WHERE id = ?").get("note");
db.close(false);
handle = await makeHandle("notes", dir, definition);
await handle.count();
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
let handle = await makeHandle("notes", dir, {});
await handle.count();
handle.close();
let db = new Database(join(dir, ".index.sqlite"), { strict: true });
const before = db.query("SELECT * FROM collection_files WHERE id = ?").get("stable");
db.close(false);
handle = await makeHandle("notes", dir, {});
await handle.count();
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
