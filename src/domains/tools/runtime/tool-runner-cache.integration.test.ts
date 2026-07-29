import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Harness from "../../../../test/fixtures/tool-runner-test-harness";

type ToolCache = Awaited<ReturnType<typeof Harness.setupToolCache>>;

const assertCachePathsAndKeys = (cache: ToolCache, cachePath: string, toolPath: string) => {
  expect(Harness.cachePathForToolPath(toolPath)).toBe(cachePath);
  expect(cache.path).toBe(cachePath);
  expect(existsSync(cachePath)).toBe(false);
  expect(cache.peek(["missing"])).toBeUndefined();
  expect(existsSync(cachePath)).toBe(true);

  const objectKey = ["todos", { b: 2, omitted: undefined, a: 1 }] as const;
  cache.set(objectKey, { ok: true });
  expect(cache.peek(["todos", { a: 1, b: 2 }])).toEqual({ ok: true });
  expect(cache.peek(["todos", { a: 1, b: 3 }])).toBeUndefined();

  const shared = { value: true };
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
    enabled: true,
  });
  cache.set(["json", null, true, 1, "text", shared, shared, nullPrototype], "valid");
  expect(cache.peek(["json", null, true, 1, "text", shared, shared, { enabled: true }])).toBe(
    "valid",
  );
};

const assertCacheQueryControls = async (cache: ToolCache, warnings: unknown[]) => {
  let calls = 0;
  const first = cache.query({
    queryKey: ["dedupe"],
    queryFn: async () => `value-${++calls}`,
  });
  const second = cache.query({
    queryKey: ["dedupe"],
    queryFn: async () => `ignored-${++calls}`,
  });
  await expect(Promise.all([first, second])).resolves.toEqual(["value-1", "value-1"]);
  expect(calls).toBe(1);
  await expect(
    cache.query({ queryKey: ["dedupe"], staleTime: Infinity, queryFn: () => "ignored" }),
  ).resolves.toBe("value-1");

  cache.set(["invalidated"], "old");
  cache.invalidate(["invalidated"]);
  await expect(
    cache.query({ queryKey: ["invalidated"], staleTime: Infinity, queryFn: () => "new" }),
  ).resolves.toBe("new");
  expect(cache.peek(["invalidated"])).toBe("new");

  cache.set(["failure"], "stale");
  await expect(
    cache.query({
      queryKey: ["failure"],
      staleTime: 0,
      queryFn: () => {
        throw new Error("foreground failure");
      },
    }),
  ).rejects.toThrow("foreground failure");
  expect(cache.peek(["failure"])).toBe("stale");
  await expect(
    cache.query({
      queryKey: ["cold-failure"],
      queryFn: () => Promise.reject(new Error("cold failure")),
    }),
  ).rejects.toThrow("cold failure");
  expect(warnings).toHaveLength(0);
};

const assertCacheRemovalAndValidation = async (cache: ToolCache) => {
  cache.set(["remove"], true);
  cache.remove(["remove"]);
  expect(cache.peek(["remove"])).toBeUndefined();
  cache.set(["clear-a"], true);
  cache.set(["clear-b"], true);
  cache.clear();
  expect(cache.peek(["clear-a"])).toBeUndefined();

  expect(() => cache.peek([])).toThrow("query keys must be non-empty arrays");
  expect(() => cache.peek("bad" as never)).toThrow("query keys must be non-empty arrays");
  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    () => true,
    Symbol("bad"),
    1n,
    new Date(),
  ]) {
    expect(() => cache.peek([invalid])).toThrow("JSON-compatible values");
  }
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  expect(() => cache.peek(cyclic)).toThrow("cannot contain cycles");
  expect(() => cache.set(["undefined"], undefined)).toThrow("cannot store undefined");
  await Promise.all(
    ([-1, Number.NaN, "bad"] as const).map((staleTime) =>
      expect(
        cache.query({
          queryKey: ["bad-stale"],
          staleTime: staleTime as never,
          queryFn: () => true,
        }),
      ).rejects.toThrow("staleTime must be a non-negative number"),
    ),
  );
};

const assertCacheCollisionDetection = (cache: ToolCache, cachePath: string) => {
  cache.set(["collision"], true);
  const row = [...(Harness.FakeSqliteDatabase.store(cachePath)?.cache.values() ?? [])].find(
    (value) => value.valueJson === "true",
  );
  expect(row).toBeDefined();
  row!.keyJson = '["different"]';
  expect(() => cache.peek(["collision"])).toThrow("query key hash collision");
};

const assertUnavailableCache = async (toolPath: string, log: never) => {
  new Harness.FakeSqliteEnvironment().uninstall();
  const cache = await Harness.setupToolCache({ path: toolPath } as never, log);
  const runtimeError = "context.cache requires the Bun SQLite runtime";
  expect(() => cache.query({ queryKey: ["key"], queryFn: () => true })).toThrow(runtimeError);
  expect(() => cache.peek(["key"])).toThrow(runtimeError);
  expect(() => cache.set(["key"], true)).toThrow(runtimeError);
  expect(() => cache.invalidate(["key"])).toThrow(runtimeError);
  expect(() => cache.remove(["key"])).toThrow(runtimeError);
  expect(() => cache.clear()).toThrow(runtimeError);
  expect(() => cache.close()).not.toThrow();
};

afterEach(Harness.cleanupToolRunnerTests);

describe("tool persistence", () => {
  test("provides a persistent query cache with foreground refreshes", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "cached");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "cached",
  description: "Cache test tool.",
  commands: {
    read: rig.defineCommand({
      description: "Read cached data.",
      input: rig.z.object({ staleTime: rig.z.number(), fail: rig.z.boolean().optional() }),
      output: rig.z.object({ value: rig.z.string(), calls: rig.z.number(), cachePath: rig.z.string() }),
      run: async (context) => {
        const value = await context.cache.query({
          queryKey: ["value"],
          staleTime: context.input.staleTime,
          queryFn: async () => {
            const calls = (context.kv.get("calls") ?? 0) + 1;
            context.kv.set("calls", calls);
            if (context.input.fail) throw new Error("refresh failed");
            return "value-" + calls;
          },
        });
        return { value, calls: context.kv.get("calls") ?? 0, cachePath: context.cache.path };
      },
    }),
  },
});
`,
      "utf8",
    );

    const runner = Harness.createToolRunner({ homeDir: home });
    const cold = await runner.run("cached", "read", {
      homeDir: home,
      input: JSON.stringify({ staleTime: 60_000 }),
    });
    const fresh = await runner.run("cached", "read", {
      homeDir: home,
      input: JSON.stringify({ staleTime: 60_000 }),
    });
    const stale = await runner.run("cached", "read", {
      homeDir: home,
      input: JSON.stringify({ staleTime: 0 }),
    });
    const refreshed = await runner.run("cached", "read", {
      homeDir: home,
      input: JSON.stringify({ staleTime: 60_000 }),
    });
    const failedRefresh = await runner.run("cached", "read", {
      homeDir: home,
      input: JSON.stringify({ staleTime: 0, fail: true }),
    });
    const cachePath = join(toolDir, "cache.sqlite");

    expect(cold).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-1", calls: 1, cachePath } },
    });
    expect(fresh).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-1", calls: 1, cachePath } },
    });
    expect(stale).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-2", calls: 2, cachePath } },
    });
    expect(refreshed).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-2", calls: 2, cachePath } },
    });
    expect(failedRefresh).toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "INTERNAL_ERROR", message: "refresh failed" }] },
    });
    expect(existsSync(cachePath)).toBe(true);
  });

  test("supports cache controls, deterministic keys, validation, and unavailable runtimes", async () => {
    expect.hasAssertions();
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const toolPath = join(home, "rig", "tools", "cache-api", "index.rig.ts");
    const warnings: Array<{ bindings: unknown; message: unknown }> = [];
    const log = {
      warn: (bindings: unknown, message: unknown) => warnings.push({ bindings, message }),
    } as never;
    const cache = await Harness.setupToolCache({ path: toolPath } as never, log);
    const cachePath = join(dirname(toolPath), "cache.sqlite");

    assertCachePathsAndKeys(cache, cachePath, toolPath);
    await assertCacheQueryControls(cache, warnings);
    await assertCacheRemovalAndValidation(cache);
    assertCacheCollisionDetection(cache, cachePath);
    cache.close();
    await assertUnavailableCache(toolPath, log);
  });

  test("closes partial lazy state initialization and retries cleanly", async () => {
    const sqlite = new Harness.FakeSqliteEnvironment();
    sqlite.install();
    const home = await Harness.homes.create();
    const toolPath = join(home, "rig", "tools", "partial", "index.rig.ts");
    const kvPath = join(dirname(toolPath), "kv.sqlite");
    const cachePath = join(dirname(toolPath), "cache.sqlite");
    const log = { warn: () => undefined } as never;

    const kv = await Harness.setupToolKvStore({ path: toolPath } as never);
    sqlite.failNextInitialization();
    expect(() => kv.get("key")).toThrow("sqlite initialization failed");
    expect(Harness.FakeSqliteDatabase.store(kvPath)?.closeRuns).toBe(1);
    expect(kv.get("key")).toBeUndefined();
    (kv as { close(): void }).close();
    expect(Harness.FakeSqliteDatabase.store(kvPath)?.closeRuns).toBe(2);

    const cache = await Harness.setupToolCache({ path: toolPath } as never, log);
    sqlite.failNextInitialization();
    expect(() => cache.peek(["key"])).toThrow("sqlite initialization failed");
    expect(Harness.FakeSqliteDatabase.store(cachePath)?.closeRuns).toBe(1);
    expect(cache.peek(["key"])).toBeUndefined();
    cache.close();
    expect(Harness.FakeSqliteDatabase.store(cachePath)?.closeRuns).toBe(2);
  });

  test("returns changed migration errors as envelopes", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const home = await Harness.homes.create();
    const writer = new Harness.DbSetupTestToolWriter(home);
    const toolPath = await writer.write(
      "db-changed",
      'db.migrate(1, "create items", "create table items (id integer primary key);");',
    );

    await expect(
      Harness.createToolRunner({ homeDir: home }).run("db-changed", "check", { homeDir: home }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writer.write(
      "db-changed",
      'db.migrate(1, "create items", "create table items (id integer primary key, text text);");',
    );
    expect(toolPath).toBe(join(home, "rig", "tools", "db-changed", "index.rig.ts"));

    const result = await Harness.createToolRunner({ homeDir: home }).run("db-changed", "check", {
      homeDir: home,
    });
    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        errors: [
          {
            code: "TOOL_INVALID",
            message: "Migration 1 has changed since it was applied.",
          },
        ],
      },
    });
  });

  test("returns invalid migration declaration errors as envelopes", async () => {
    new Harness.FakeSqliteEnvironment().install();
    const cases = [
      {
        name: "db-order",
        setup:
          'db.migrate(2, "create second", "create table second (id integer primary key);"); db.migrate(1, "create first", "create table first (id integer primary key);");',
        message: "Migration versions must be declared in ascending order",
      },
      {
        name: "db-version",
        setup: 'db.migrate(0, "bad", "select 1;");',
        message: "Migration version must be a positive integer",
      },
      {
        name: "db-name",
        setup: 'db.migrate(1, " ", "select 1;");',
        message: "Migration name must not be empty.",
      },
      {
        name: "db-sql",
        setup: 'db.migrate(1, "empty", " ");',
        message: "Migration 1 SQL must not be empty.",
      },
    ];

    const results = await Promise.all(
      cases.map(async (item) => {
        const home = await Harness.homes.create();
        await new Harness.DbSetupTestToolWriter(home).write(item.name, item.setup);
        return {
          item,
          result: await Harness.createToolRunner({ homeDir: home }).run(item.name, "check", {
            homeDir: home,
          }),
        };
      }),
    );

    for (const { item, result } of results) {
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          errors: [{ code: "TOOL_INVALID", message: expect.stringContaining(item.message) }],
        },
      });
    }
  });

  test("requires setupDb before commands use context.db", async () => {
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "missing-db");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "missing-db",
  description: "Missing setupDb test tool.",
  commands: {
    read: rig.defineCommand({
      description: "Read from DB without setupDb.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async (context) => {
        context.db.query("select 1").get();
        return { ok: true };
      },
    }),
  },
});
`,
      "utf8",
    );

    await expect(
      Harness.createToolRunner({ homeDir: home }).run("missing-db", "read", { homeDir: home }),
    ).resolves.toMatchObject({
      exitCode: 1,
      envelope: {
        errors: [
          {
            code: "TOOL_INVALID",
            message: "Tool missing-db must define setupDb before using context.db.",
          },
        ],
      },
    });
  });
});
