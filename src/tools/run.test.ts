import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ToolCreator } from "./create";
import { ToolCacheService } from "./cache";
import { ToolDatabaseService } from "./db";
import { ToolHelpService } from "./help";
import { ToolInspector } from "./inspect";
import { ToolKvStoreService } from "./kv";
import { ToolListService } from "./list";
import { ToolRunner } from "./run";
import { ToolTypecheckService } from "./typecheck";

class TestHomeStore {
  private readonly homes: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-test-home-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    new FakeSqliteEnvironment().uninstall();
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

class FakeSqliteStore {
  readonly kv = new Map<string, string>();
  readonly cache = new Map<
    string,
    {
      keyJson: string;
      valueJson: string;
      dataUpdatedAt: number;
      invalidatedAt: number | null;
      lastAccessedAt: number;
    }
  >();
  readonly migrations = new Map<number, { name: string; checksum: string }>();
  readonly notes: string[] = [];
  setupRuns = 0;
}

class FakeSqliteStatement {
  constructor(
    private readonly store: FakeSqliteStore,
    private readonly sql: string,
  ) {}

  get(params?: unknown): unknown {
    if (this.sql.includes("from _rig_migrations")) {
      return this.store.migrations.get(Number(params)) ?? null;
    }
    if (this.sql.includes("from _rig_kv")) {
      const valueJson = this.store.kv.get(String(params));
      return valueJson === undefined ? null : { value_json: valueJson };
    }
    if (this.sql.includes("from _rig_cache")) {
      const row = this.store.cache.get(String(params));
      if (!row) return null;
      return {
        key_json: row.keyJson,
        value_json: row.valueJson,
        data_updated_at: row.dataUpdatedAt,
        invalidated_at: row.invalidatedAt,
      };
    }
    if (this.sql.includes("count(*) as count from setup_runs")) {
      return { count: this.store.setupRuns };
    }
    return null;
  }

  run(params?: unknown): { lastInsertRowid: number; changes: number } {
    const record = this.recordParams(params);
    if (this.sql.includes("into _rig_migrations")) {
      this.store.migrations.set(Number(record.version), {
        name: String(record.name),
        checksum: String(record.checksum),
      });
      return { lastInsertRowid: Number(record.version), changes: 1 };
    }
    if (this.sql.includes("into setup_runs")) {
      this.store.setupRuns++;
      return { lastInsertRowid: this.store.setupRuns, changes: 1 };
    }
    if (this.sql.includes("into _rig_kv")) {
      this.store.kv.set(String(record.key), String(record.valueJson));
      return { lastInsertRowid: this.store.kv.size, changes: 1 };
    }
    if (this.sql.includes("into _rig_cache")) {
      this.store.cache.set(String(record.keyHash), {
        keyJson: String(record.keyJson),
        valueJson: String(record.valueJson),
        dataUpdatedAt: Number(record.dataUpdatedAt),
        invalidatedAt: null,
        lastAccessedAt: Number(record.lastAccessedAt),
      });
      return { lastInsertRowid: this.store.cache.size, changes: 1 };
    }
    if (this.sql.includes("set invalidated_at")) {
      const row = this.store.cache.get(String(record.keyHash));
      if (row) row.invalidatedAt = Number(record.invalidatedAt);
      return { lastInsertRowid: 0, changes: row ? 1 : 0 };
    }
    if (this.sql.includes("set last_accessed_at")) {
      const row = this.store.cache.get(String(record.keyHash));
      if (row) row.lastAccessedAt = Number(record.lastAccessedAt);
      return { lastInsertRowid: 0, changes: row ? 1 : 0 };
    }
    if (this.sql.includes("delete from _rig_cache where")) {
      const deleted = this.store.cache.delete(String(params));
      return { lastInsertRowid: 0, changes: deleted ? 1 : 0 };
    }
    if (this.sql.includes("into notes")) {
      this.store.notes.push(String(record.text));
      return { lastInsertRowid: this.store.notes.length, changes: 1 };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  private recordParams(params: unknown): Record<string, unknown> {
    return typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  }
}

class FakeSqliteDatabase {
  private static readonly stores = new Map<string, FakeSqliteStore>();
  private readonly store: FakeSqliteStore;

  constructor(filename: string) {
    if (!existsSync(filename)) writeFileSync(filename, "");
    const existing = FakeSqliteDatabase.stores.get(filename);
    this.store = existing ?? new FakeSqliteStore();
    FakeSqliteDatabase.stores.set(filename, this.store);
  }

  static reset(): void {
    this.stores.clear();
  }

  static store(filename: string): FakeSqliteStore | undefined {
    return this.stores.get(filename);
  }

  query(sql: string): FakeSqliteStatement {
    return new FakeSqliteStatement(this.store, sql);
  }

  run(sql: string): { lastInsertRowid: number; changes: number } {
    if (sql.includes("delete from _rig_cache")) {
      const changes = this.store.cache.size;
      this.store.cache.clear();
      return { lastInsertRowid: 0, changes };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  transaction<T>(callback: () => T): () => T {
    return () => callback();
  }

  close(): void {}
}

class FakeSqliteEnvironment {
  install(): void {
    (
      globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: unknown }
    ).rigSqliteDatabaseForTests = FakeSqliteDatabase;
  }

  uninstall(): void {
    delete (globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: unknown })
      .rigSqliteDatabaseForTests;
    FakeSqliteDatabase.reset();
  }
}

const homes = new TestHomeStore();

afterEach(async () => {
  await homes.cleanup();
});

class DbSetupTestToolWriter {
  constructor(private readonly home: string) {}

  async write(name: string, setup: string): Promise<string> {
    const toolDir = join(this.home, "rig", "tools", name);
    await mkdir(toolDir, { recursive: true });
    const toolPath = join(toolDir, "index.rig.ts");
    await writeFile(toolPath, this.source(name, setup), "utf8");
    return toolPath;
  }

  private source(name: string, setup: string): string {
    return `export default (rig) => rig.defineTool({
  name: ${JSON.stringify(name)},
  description: "DB error test tool.",
  setupDb: (db) => { ${setup} },
  commands: {
    check: rig.defineCommand({
      description: "Check DB setup.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;
  }
}

describe("tool commands", () => {
  test("creates a starter tool with definition-owned examples", async () => {
    const home = await homes.create();
    const result = await new ToolCreator({ homeDir: home }).create("sample");
    expect(result.files).toHaveLength(1);
    expect(result.toolPath).toBe(join(home, "rig", "tools", "sample", "index.rig.ts"));
    expect(result.id).toBe("sample.example");

    const help = await new ToolHelpService({ homeDir: home }).render("sample", "example");
    const commandIdHelp = await new ToolHelpService({ homeDir: home }).render("sample.example");
    expect(commandIdHelp).toMatch(
      /^Tool: sample\nCommand: example\nRun: rig run sample\.example \[args\.\.\.\]/,
    );
    expect(commandIdHelp).not.toContain("```bash");
    expect(help).toContain("Pass custom text");
    expect(help).toContain("rig run sample.example");
    expect(help).toContain("Input:");
    expect(help).toContain("Output:");
  });

  test("inspects command metadata as JSON", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const inspected = await new ToolInspector({ homeDir: home }).inspect("sample", "example");
    expect(inspected).toMatchObject({
      tool: "sample",
      command: "example",
      id: "sample.example",
      run: "rig run sample.example [args...]",
    });
  });

  test("type-checks generated tools with injected Rig runtime types", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolTypecheckService({ homeDir: home }).typecheck("sample");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.checked).toHaveLength(1);
  });

  test("type-checks command output against output schemas", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "bad-output");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: "bad-output",
  description: "Bad output test tool.",
  commands: {
    example: rig.defineCommand({
      description: "Return the wrong output type.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async ({ input }) => ({ text: 123 }),
    }),
  },
});

export default tool;
`,
      "utf8",
    );

    const result = await new ToolTypecheckService({ homeDir: home }).typecheck("bad-output");

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
  });

  test("runs a command and returns a success envelope", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["Agent"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Agent" },
      errors: [],
    });
  });

  test("resolves pipeline references in command input", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");

    const result = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.output"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });

    const exactId = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=@clean"],
      pipeContext: { clean: "image.cleaned.png" },
    });
    expect(exactId.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });

    const embedded = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=output:@clean.output"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(embedded.envelope).toMatchObject({
      data: { text: "output:image.cleaned.png" },
      errors: [],
    });

    const arrayInput = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      input: JSON.stringify({ text: "@names.0", ignored: ["@names.0"] }),
      pipeContext: { names: ["image.cleaned.png"] },
    });
    expect(arrayInput.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });
  });

  test("returns pipeline reference errors as envelopes", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const runner = new ToolRunner({ homeDir: home });

    const unknown = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@missing.output"],
      pipeContext: {},
    });
    expect(unknown.envelope).toMatchObject({
      errors: [{ code: "INPUT_ERROR", message: "Pipeline reference is unknown: @missing" }],
    });

    const cannotAccess = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.output.path"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(cannotAccess.envelope).toMatchObject({
      errors: [
        {
          code: "INPUT_ERROR",
          message: "Pipeline reference cannot access: @clean.output.path",
        },
      ],
    });

    const missing = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.missing"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(missing.envelope).toMatchObject({
      errors: [{ code: "INPUT_ERROR", message: "Pipeline reference is missing: @clean.missing" }],
    });
  });

  test("runs registered tools from a tool context", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, "rig", "tools", "caller");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "caller",
  description: "Tool runner test tool.",
  commands: {
    call: rig.defineCommand({
      description: "Call another Rig tool.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => {
        const result = await context.rig.run({
          command: "sample.example",
          input: { text: context.input.text },
        });
        return { text: result.text };
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("caller", "call", {
      homeDir: home,
      input: '{"text":"Nested"}',
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Nested" },
      errors: [],
    });
  });

  test("runs tools that import modules resolved from node_modules", async () => {
    const home = await homes.create();
    const packageDir = join(home, "node_modules", "tool-helper");
    const toolDir = join(home, "rig", "tools", "external-import");
    await mkdir(packageDir, { recursive: true });
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      '{"name":"tool-helper","type":"module","exports":"./index.js"}\n',
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.js"),
      "export function shout(value) { return String(value).toUpperCase(); }\n",
      "utf8",
    );
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `import { shout } from "tool-helper";

export default (rig) => rig.defineTool({
  name: "external-import",
  description: "External import test tool.",
  commands: {
    shout: rig.defineCommand({
      description: "Use an imported helper.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => ({ text: shout(context.input.text) }),
    }),
  },
});
`,
      "utf8",
    );

    const originalCwd = process.cwd();
    try {
      const result = await new ToolRunner({ homeDir: home }).run("external-import", "shout", {
        homeDir: home,
        input: '{"text":"modules"}',
      });
      expect(result).toMatchObject({
        exitCode: 0,
        envelope: { data: { text: "MODULES" }, errors: [] },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("validates tool .env and passes it to command contexts", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "with-env");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, ".env"),
      [
        "# Local tool env",
        "API_TOKEN=secret",
        "LIMIT=3",
        'MESSAGE="hello world"',
        "SINGLE='literal value'",
        "export OWNER=agent",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "with-env",
  description: "Env test tool.",
  env: rig.z.object({
    API_TOKEN: rig.z.string().min(1),
    LIMIT: rig.z.coerce.number(),
    MESSAGE: rig.z.string(),
    SINGLE: rig.z.string(),
    OWNER: rig.z.string(),
  }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({
        token: rig.z.string(),
        limit: rig.z.number(),
        message: rig.z.string(),
        single: rig.z.string(),
        owner: rig.z.string(),
      }),
      run: async (context) => ({
        token: context.env.API_TOKEN,
        limit: context.env.LIMIT,
        message: context.env.MESSAGE,
        single: context.env.SINGLE,
        owner: context.env.OWNER,
      }),
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("with-env", "read", {
      homeDir: home,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      envelope: {
        data: {
          token: "secret",
          limit: 3,
          message: "hello world",
          single: "literal value",
          owner: "agent",
        },
        errors: [],
      },
    });

    const dryRun = await new ToolRunner({ homeDir: home }).run("with-env", "read", {
      homeDir: home,
      dryRun: true,
    });
    expect(JSON.stringify(dryRun.envelope)).not.toContain("secret");
  });

  test("returns tool env load errors as envelopes", async () => {
    const cases = [
      {
        name: "missing-env",
        envFile: undefined,
        envSchema: "env: rig.z.object({ API_TOKEN: rig.z.string().min(1) }),",
        message: "env is invalid",
      },
      {
        name: "env-without-schema",
        envFile: "API_TOKEN=secret\n",
        envSchema: "",
        message: "has .env but no env schema",
      },
      {
        name: "bad-env-line",
        envFile: "not a valid env line\n",
        envSchema: "env: rig.z.object({}),",
        message: "Invalid .env line",
      },
    ];

    const results = await Promise.all(
      cases.map(async (item) => {
        const home = await homes.create();
        const toolDir = join(home, "rig", "tools", item.name);
        await mkdir(toolDir, { recursive: true });
        if (item.envFile !== undefined)
          await writeFile(join(toolDir, ".env"), item.envFile, "utf8");
        await writeFile(
          join(toolDir, "index.rig.ts"),
          `export default (rig) => rig.defineTool({
  name: ${JSON.stringify(item.name)},
  description: "Env error test tool.",
  ${item.envSchema}
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
          "utf8",
        );

        return {
          item,
          result: await new ToolRunner({ homeDir: home }).run(item.name, "read", {
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

  test("runs setupDb before commands and stores index.sqlite beside the tool", async () => {
    new FakeSqliteEnvironment().install();
    const home = await homes.create();
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

    const runner = new ToolRunner({ homeDir: home });
    const first = await runner.run("notes", "add", { homeDir: home, args: ["text=one"] });
    const second = await runner.run("notes", "add", { homeDir: home, args: ["text=two"] });
    const dbPath = join(toolDir, "index.sqlite");

    expect(new ToolDatabaseService().dbPathForToolPath(join(toolDir, "index.rig.ts"))).toBe(dbPath);
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

  test("provides tool loggers and sqlite-backed key-value state", async () => {
    new FakeSqliteEnvironment().install();
    const home = await homes.create();
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

    const runner = new ToolRunner({ homeDir: home });
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

    expect(new ToolKvStoreService().kvPathForToolPath(join(toolDir, "index.rig.ts"))).toBe(kvPath);
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

    const logOutput = await readFile(join(home, "rig", ".logs", "rig.log"), "utf8");
    expect(logOutput).toContain('"prefix":"tool:stateful.write"');
    expect(logOutput).toContain("Stored key-value state.");

    const kv = await new ToolKvStoreService().setup({
      path: join(toolDir, "index.rig.ts"),
    } as never);
    expect(() => kv.get("")).toThrow("context.kv keys must be non-empty strings.");
    (kv as unknown as { close(): void }).close();

    new FakeSqliteEnvironment().uninstall();
    const unavailable = await new ToolKvStoreService().setup({
      path: join(home, "unavailable", "index.rig.ts"),
    } as never);
    expect(unavailable.path).toBe(join(home, "unavailable", "kv.sqlite"));
    expect(() => unavailable.get("key")).toThrow("context.kv requires the Bun SQLite runtime");
    expect(() => unavailable.set("key", "value")).toThrow(
      "context.kv requires the Bun SQLite runtime",
    );
  });

  test("provides a persistent stale-while-revalidate query cache", async () => {
    new FakeSqliteEnvironment().install();
    const home = await homes.create();
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

    const runner = new ToolRunner({ homeDir: home });
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
      envelope: { data: { value: "value-1", calls: 2, cachePath } },
    });
    expect(refreshed).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-2", calls: 2, cachePath } },
    });
    expect(failedRefresh).toMatchObject({
      exitCode: 0,
      envelope: { data: { value: "value-2", calls: 3, cachePath } },
    });
    expect(existsSync(cachePath)).toBe(true);
    expect(await readFile(join(home, "rig", ".logs", "rig.log"), "utf8")).toContain(
      "Cache revalidation failed.",
    );
  });

  test("supports cache controls, deterministic keys, validation, and unavailable runtimes", async () => {
    new FakeSqliteEnvironment().install();
    const home = await homes.create();
    const toolPath = join(home, "rig", "tools", "cache-api", "index.rig.ts");
    const warnings: Array<{ bindings: unknown; message: unknown }> = [];
    const log = {
      warn: (bindings: unknown, message: unknown) => warnings.push({ bindings, message }),
    } as never;
    const service = new ToolCacheService();
    const cache = await service.setup({ path: toolPath } as never, log);
    const cachePath = join(dirname(toolPath), "cache.sqlite");

    expect(service.cachePathForToolPath(toolPath)).toBe(cachePath);
    expect(cache.path).toBe(cachePath);
    expect(cache.peek(["missing"])).toBeUndefined();

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
      cache.query({
        queryKey: ["invalidated"],
        staleTime: Infinity,
        queryFn: () => "new",
      }),
    ).resolves.toBe("old");
    await cache.settle();
    expect(cache.peek(["invalidated"])).toBe("new");

    cache.set(["failure"], "stale");
    await expect(
      cache.query({
        queryKey: ["failure"],
        staleTime: 0,
        queryFn: () => {
          throw new Error("background failure");
        },
      }),
    ).resolves.toBe("stale");
    await cache.settle();
    expect(cache.peek(["failure"])).toBe("stale");
    expect(warnings).toHaveLength(1);

    await expect(
      cache.query({
        queryKey: ["cold-failure"],
        queryFn: () => Promise.reject(new Error("cold failure")),
      }),
    ).rejects.toThrow("cold failure");
    expect(warnings).toHaveLength(1);

    cache.set(["remove"], true);
    cache.remove(["remove"]);
    expect(cache.peek(["remove"])).toBeUndefined();
    cache.set(["clear-a"], true);
    cache.set(["clear-b"], true);
    cache.clear();
    expect(cache.peek(["clear-a"])).toBeUndefined();

    expect(() => cache.peek([])).toThrow("query keys must be non-empty arrays");
    expect(() => cache.peek("bad" as never)).toThrow("query keys must be non-empty arrays");
    expect(() => cache.peek([Number.NaN])).toThrow("JSON-compatible values");
    expect(() => cache.peek([Number.POSITIVE_INFINITY])).toThrow("JSON-compatible values");
    expect(() => cache.peek([undefined])).toThrow("JSON-compatible values");
    expect(() => cache.peek([() => true])).toThrow("JSON-compatible values");
    expect(() => cache.peek([Symbol("bad")])).toThrow("JSON-compatible values");
    expect(() => cache.peek([1n])).toThrow("JSON-compatible values");
    expect(() => cache.peek([new Date()])).toThrow("JSON-compatible values");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => cache.peek(cyclic)).toThrow("cannot contain cycles");
    expect(() => cache.set(["undefined"], undefined)).toThrow("cannot store undefined");
    await expect(
      cache.query({ queryKey: ["bad-stale"], staleTime: -1, queryFn: () => true }),
    ).rejects.toThrow("staleTime must be a non-negative number");
    await expect(
      cache.query({ queryKey: ["bad-stale"], staleTime: Number.NaN, queryFn: () => true }),
    ).rejects.toThrow("staleTime must be a non-negative number");
    await expect(
      cache.query({ queryKey: ["bad-stale"], staleTime: "bad" as never, queryFn: () => true }),
    ).rejects.toThrow("staleTime must be a non-negative number");

    cache.set(["collision"], true);
    const row = [...(FakeSqliteDatabase.store(cachePath)?.cache.values() ?? [])].find(
      (value) => value.valueJson === "true",
    );
    expect(row).toBeDefined();
    row!.keyJson = '["different"]';
    expect(() => cache.peek(["collision"])).toThrow("query key hash collision");
    cache.close();

    new FakeSqliteEnvironment().uninstall();
    const unavailable = await service.setup({ path: toolPath } as never, log);
    expect(() => unavailable.query({ queryKey: ["key"], queryFn: () => true })).toThrow(
      "context.cache requires the Bun SQLite runtime",
    );
    expect(() => unavailable.peek(["key"])).toThrow(
      "context.cache requires the Bun SQLite runtime",
    );
    expect(() => unavailable.set(["key"], true)).toThrow(
      "context.cache requires the Bun SQLite runtime",
    );
    expect(() => unavailable.invalidate(["key"])).toThrow(
      "context.cache requires the Bun SQLite runtime",
    );
    expect(() => unavailable.remove(["key"])).toThrow(
      "context.cache requires the Bun SQLite runtime",
    );
    expect(() => unavailable.clear()).toThrow("context.cache requires the Bun SQLite runtime");
    await expect(unavailable.settle()).resolves.toBeUndefined();
    expect(() => unavailable.close()).not.toThrow();
  });

  test("does not let cache cleanup failures mask command results", async () => {
    const runner = new ToolRunner();
    await expect(
      (
        runner as unknown as {
          settleCache(cache: { settle(): Promise<void> }): Promise<void>;
        }
      ).settleCache({ settle: () => Promise.reject(new Error("settle failed")) }),
    ).resolves.toBeUndefined();
    expect(() =>
      (
        runner as unknown as {
          closeCache(cache: { close(): void }): void;
        }
      ).closeCache({
        close: () => {
          throw new Error("close failed");
        },
      }),
    ).not.toThrow();
  });

  test("returns changed migration errors as envelopes", async () => {
    new FakeSqliteEnvironment().install();
    const home = await homes.create();
    const writer = new DbSetupTestToolWriter(home);
    const toolPath = await writer.write(
      "db-changed",
      'db.migrate(1, "create items", "create table items (id integer primary key);");',
    );

    await expect(
      new ToolRunner({ homeDir: home }).run("db-changed", "check", { homeDir: home }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writer.write(
      "db-changed",
      'db.migrate(1, "create items", "create table items (id integer primary key, text text);");',
    );
    expect(toolPath).toBe(join(home, "rig", "tools", "db-changed", "index.rig.ts"));

    const result = await new ToolRunner({ homeDir: home }).run("db-changed", "check", {
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
    new FakeSqliteEnvironment().install();
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
        const home = await homes.create();
        await new DbSetupTestToolWriter(home).write(item.name, item.setup);
        return {
          item,
          result: await new ToolRunner({ homeDir: home }).run(item.name, "check", {
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
    const home = await homes.create();
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
      new ToolRunner({ homeDir: home }).run("missing-db", "read", { homeDir: home }),
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

  test("renders a compact plain command list", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const service = new ToolListService({ homeDir: home });
    const list = await service.list();

    const rendered = service.renderPlain(list);
    expect(rendered).toContain("rig run sample.example text=example #");
  });

  test("dry-runs a command without execution", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, "rig", "tools", "writer");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "writer",
  description: "Writer test tool.",
  commands: {
    save: rig.defineCommand({
      description: "Save text.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => {
        throw new Error("dry-run should not execute command code");
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("writer", "save", {
      homeDir: home,
      args: ["text=Agent"],
      dryRun: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: {
        dryRun: true,
        wouldRun: false,
        id: "writer.save",
        input: { text: "Agent" },
      },
      errors: [],
    });
  });

  test("truncates large command output and saves the full data to a temp file", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, "rig", "tools", "large");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "large",
  description: "Large output test tool.",
  commands: {
    dump: rig.defineCommand({
      description: "Dump large text.",
      input: rig.z.object({}),
      output: rig.z.object({ text: rig.z.string() }),
      run: async () => ({ text: "x".repeat(60 * 1024) }),
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("large", "dump", {
      homeDir: home,
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: {
        truncated: true,
        previewFormat: "partial-json",
        fullOutputFormat: "json",
        totalBytes: expect.any(Number),
        shownBytes: expect.any(Number),
      },
      errors: [],
    });

    const envelope = result.envelope as { data: { fullOutputPath: string } };
    const fullOutput = await readFile(envelope.data.fullOutputPath, "utf8");
    expect(fullOutput).toContain('"text"');
    expect(fullOutput.length).toBeGreaterThan(60 * 1024);
  });

  test("accepts raw Zod schemas without rig.input/output wrappers", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "raw-schema");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `import { RigTool, z } from "../../runtime/sdk";

export default RigTool.define({
  name: "raw-schema",
  description: "Raw schema test tool.",
  commands: {
    echo: {
      description: "Echo using raw z.object.",
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      run: async ({ input }) => ({ text: input.text }),
    },
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("raw-schema", "echo", {
      homeDir: home,
      input: '{"text":"Agent"}',
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Agent" },
      errors: [],
    });
  });

  test("returns an error envelope for invalid input", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      input: '{"text":123}',
    });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      data: null,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "Invalid input.",
          details: {
            issues: [
              {
                path: "text",
                message: expect.any(String),
              },
            ],
          },
        },
      ],
    });
  });
});
