import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Harness from "../../../../test/fixtures/tool-runner-test-harness";

const assertUnavailableKvRuntime = async (home: string) => {
  new Harness.FakeSqliteEnvironment().uninstall();
  const unavailable = await Harness.setupToolKvStore({
    path: join(home, "unavailable", "index.rig.ts"),
  } as never);
  expect(unavailable.path).toBe(join(home, "unavailable", "kv.sqlite"));
  expect(() => unavailable.get("key")).toThrow("context.kv requires the Bun SQLite runtime");
  expect(() => unavailable.set("key", "value")).toThrow(
    "context.kv requires the Bun SQLite runtime",
  );
};

afterEach(Harness.cleanupToolRunnerTests);

describe("tool databases", () => {
  test("runs setupDb before commands and stores index.sqlite beside the tool", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "notes");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "notes",
  description: "SQLite notes test tool.",
  setupDb: (db) => {
    db.migrate(1, "create notes", \`
      create table notes (
        id integer primary key,
        text text not null
      );
      create table setup_runs (
        id integer primary key,
        created_at text not null
      );
    \`);
    db.migrate(2, "index notes", "create index notes_text_idx on notes(text);");
    db.query("insert into setup_runs (created_at) values ($createdAt)").run({
      createdAt: new Date().toISOString(),
    });
  },
  commands: {
    add: rig.defineCommand({
      description: "Add a note.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({
        id: rig.z.number(),
        setupRuns: rig.z.number(),
        dbPath: rig.z.string(),
      }),
      run: async (context) => {
        const inserted = context.db
          .query("insert into notes (text) values ($text)")
          .run({ text: context.input.text });
        const row = context.db.query("select count(*) as count from setup_runs").get() as { count: number };
        return { id: inserted.lastInsertRowid, setupRuns: row.count, dbPath: context.db.path };
      },
    }),
  },
});
`,
      "utf8",
    );

    const runner = Harness.createToolRunner({ homeDir: home });
    const first = await runner.run("notes", "add", { homeDir: home, args: ["text=one"] });
    const second = await runner.run("notes", "add", { homeDir: home, args: ["text=two"] });
    const dbPath = join(toolDir, "index.sqlite");

    expect(Harness.databasePathForToolPath(join(toolDir, "index.rig.ts"))).toBe(dbPath);
    expect(first).toMatchObject({
      exitCode: 0,
      envelope: { data: { id: 1, setupRuns: 1, dbPath } },
    });
    expect(second).toMatchObject({
      exitCode: 0,
      envelope: { data: { id: 2, setupRuns: 2, dbPath } },
    });
    expect(existsSync(dbPath)).toBe(true);
  });

  test("closes databases when factory initialization or setupDb fails", async () => {
    const sqlite = new Harness.FakeSqliteEnvironment();
    sqlite.install();
    const home = await Harness.homes.create();
    const toolPath = join(home, "rig", "tools", "failure", "index.rig.ts");
    const dbPath = join(dirname(toolPath), "index.sqlite");
    sqlite.failNextInitialization();
    await expect(
      Harness.setupToolDatabase({
        path: toolPath,
        definition: { setupDb: () => undefined },
      } as never),
    ).rejects.toThrow("sqlite initialization failed");
    expect(Harness.FakeSqliteDatabase.store(dbPath)?.closeRuns).toBe(1);

    await expect(
      Harness.setupToolDatabase({
        path: toolPath,
        definition: {
          setupDb: () => {
            throw new Error("setupDb failed");
          },
        },
      } as never),
    ).rejects.toThrow("setupDb failed");
    expect(Harness.FakeSqliteDatabase.store(dbPath)?.closeRuns).toBe(2);
  });

  test("skips collection initialization when a command does not use collections", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "partial-setup");
    const toolPath = join(toolDir, "index.rig.ts");
    const dbPath = join(toolDir, "index.sqlite");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "blocked"), "prevents collection directory creation", "utf8");
    await writeFile(
      toolPath,
      `export default (rig) => rig.defineTool({
  name: "partial-setup",
  description: "Partial setup cleanup test.",
  setupDb: () => {},
  collections: { blocked: {} },
  commands: {
    read: rig.defineCommand({
      description: "Should not run.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});`,
      "utf8",
    );

    const result = await Harness.createToolRunner({ homeDir: home }).run("partial-setup", "read", {
      homeDir: home,
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({ data: { ok: true } });
    expect(Harness.FakeSqliteDatabase.store(dbPath)?.closeRuns).toBe(1);
  });

  test("provides tool loggers and sqlite-backed key-value state", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "stateful");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "stateful",
  description: "KV and logger test tool.",
  commands: {
    write: rig.defineCommand({
      description: "Write lightweight state.",
      input: rig.z.object({ key: rig.z.string(), value: rig.z.string() }),
      output: rig.z.object({ previous: rig.z.string().optional(), current: rig.z.string(), kvPath: rig.z.string() }),
      run: async (context) => {
        const previous = context.kv.get(context.input.key);
        context.kv.set(context.input.key, context.input.value);
        context.log.info({ key: context.input.key }, "Stored key-value state.");
        return {
          previous,
          current: context.kv.get(context.input.key),
          kvPath: context.kv.path,
        };
      },
    }),
    bad: rig.defineCommand({
      description: "Reject bad state.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async (context) => {
        context.kv.set("bad", undefined);
        return { ok: true };
      },
    }),
  },
});
`,
      "utf8",
    );

    const runner = Harness.createToolRunner({ homeDir: home });
    const first = await runner.run("stateful", "write", {
      homeDir: home,
      args: ["key=name", "value=one"],
    });
    const second = await runner.run("stateful", "write", {
      homeDir: home,
      args: ["key=name", "value=two"],
    });
    const bad = await runner.run("stateful", "bad", { homeDir: home });
    const kvPath = join(toolDir, "kv.sqlite");

    expect(Harness.kvPathForToolPath(join(toolDir, "index.rig.ts"))).toBe(kvPath);
    expect(first).toMatchObject({
      exitCode: 0,
      envelope: { data: { current: "one", kvPath } },
    });
    expect(second).toMatchObject({
      exitCode: 0,
      envelope: { data: { previous: "one", current: "two", kvPath } },
    });
    expect(bad).toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "INPUT_ERROR" }] },
    });
    expect(existsSync(kvPath)).toBe(true);
    expect(existsSync(join(toolDir, "cache.sqlite"))).toBe(false);
    expect(Harness.FakeSqliteDatabase.store(kvPath)?.closeRuns).toBe(3);

    const logOutput = await readFile(join(home, "rig", ".logs", "rig.log"), "utf8");
    expect(logOutput).toContain('"prefix":"tool:stateful.write"');
    expect(logOutput).toContain("Stored key-value state.");

    const kv = await Harness.setupToolKvStore({
      path: join(toolDir, "index.rig.ts"),
    } as never);
    expect(() => kv.get("")).toThrow("context.kv keys must be non-empty strings.");
    (kv as unknown as { close(): void }).close();

    await assertUnavailableKvRuntime(home);
  });
});
