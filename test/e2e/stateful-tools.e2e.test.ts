import { existsSync } from "node:fs";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RigE2EHarnessClass, rigE2EHarnessFactory } from "./harness";

type SuccessEnvelope<T> = {
  data: T;
  errors: [];
};

type ErrorEnvelope = {
  data: null;
  errors: Array<{ code: string; message: string; details?: unknown }>;
};

class StatefulE2EFixtureClass {
  public readonly toolDir: string;
  private readonly fixtureDir = fileURLToPath(new URL("./fixtures/stateful", import.meta.url));

  constructor(
    params: { toolName: string },
    private readonly deps: { rig: RigE2EHarnessClass },
  ) {
    this.toolDir = join(deps.rig.rigHomeDir, "rig", "tools", params.toolName);
  }

  public async install(): Promise<void> {
    await this.deps.rig.run({ args: ["init"] });
    const source = await readFile(join(this.fixtureDir, "index.rig.ts"), "utf8");
    await this.deps.rig.writeRigFile(join("rig", "tools", "stateful", "index.rig.ts"), source);
    const noopSource = await readFile(join(this.fixtureDir, "noop", "index.rig.ts"), "utf8");
    await this.deps.rig.writeRigFile(join("rig", "tools", "noop", "index.rig.ts"), noopSource);
    const env = await this.deps.rig.run({
      args: ["env", "stateful", "TOKEN=tool-secret"],
    });
    if (env.exitCode !== 0) throw new Error(`Could not configure fixture env: ${env.stderr}`);
  }

  public async run<T>(command: string, input: Record<string, unknown> = {}): Promise<T> {
    const result = await this.deps.rig.run({
      args: ["run", `stateful.${command}`, "--input", JSON.stringify(input)],
      env: { TOKEN: "process-secret" },
    });
    if (result.exitCode !== 0) {
      throw new Error(`Stateful command failed: ${result.stdout}\n${result.stderr}`);
    }
    return result.json<SuccessEnvelope<T>>().data;
  }

  public async runError(
    command: string,
    input: Record<string, unknown> = {},
  ): Promise<ErrorEnvelope> {
    const result = await this.deps.rig.run({
      args: ["run", `stateful.${command}`, "--input", JSON.stringify(input)],
    });
    if (result.exitCode !== 1) {
      throw new Error(`Stateful command unexpectedly succeeded: ${result.stdout}`);
    }
    return result.json<ErrorEnvelope>();
  }

  public async source(): Promise<string> {
    return readFile(join(this.fixtureDir, "index.rig.ts"), "utf8");
  }
}

describe("built Rig CLI stateful tool capabilities", () => {
  let rig: RigE2EHarnessClass;
  let fixture: StatefulE2EFixtureClass;

  beforeEach(async () => {
    rig = await rigE2EHarnessFactory.create();
    fixture = new StatefulE2EFixtureClass({ toolName: "stateful" }, { rig });
    await fixture.install();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  test("isolates env and persists database and KV state across CLI processes", async () => {
    await expect(fixture.run("env")).resolves.toEqual({
      token: "tool-secret",
      processToken: "process-secret",
    });

    await expect(fixture.run("db", { name: "runs" })).resolves.toEqual({ value: 1 });
    await expect(fixture.run("db", { name: "runs" })).resolves.toEqual({ value: 2 });
    expect(existsSync(join(fixture.toolDir, "index.sqlite"))).toBe(true);

    await expect(
      fixture.run("kv", { action: "set", key: "profile", value: { active: true } }),
    ).resolves.toEqual({ value: { active: true } });
    await expect(fixture.run("kv", { action: "get", key: "profile" })).resolves.toEqual({
      value: { active: true },
    });
    expect(existsSync(join(fixture.toolDir, "kv.sqlite"))).toBe(true);
  });

  test("detects migration checksum drift and recovers after the source is restored", async () => {
    await fixture.run("db", { name: "runs" });
    const original = await fixture.source();
    const changed = original.replace(
      "create table counters (",
      "create table counters ( /* changed migration */",
    );
    await rig.writeRigFile(join("rig", "tools", "stateful", "index.rig.ts"), changed);

    const drift = await fixture.runError("db", { name: "runs" });
    expect(drift.errors[0]).toMatchObject({
      code: "TOOL_INVALID",
      message: "Migration 1 has changed since it was applied.",
    });

    await rig.writeRigFile(join("rig", "tools", "stateful", "index.rig.ts"), original);
    await expect(fixture.run("db", { name: "runs" })).resolves.toEqual({ value: 2 });
  });

  test("supports cache freshness, foreground refresh, invalidation, removal, and clearing", async () => {
    await expect(
      fixture.run("cache", {
        action: "query",
        key: "one",
        value: "initial",
        staleTime: 60_000,
      }),
    ).resolves.toMatchObject({ value: "initial" });
    await expect(
      fixture.run("cache", {
        action: "query",
        key: "one",
        value: "ignored-while-fresh",
        staleTime: 60_000,
      }),
    ).resolves.toMatchObject({ value: "initial" });

    await fixture.run("cache", { action: "invalidate", key: "one" });
    const refreshed = await fixture.run<{ value: string; elapsedMs: number }>("cache", {
      action: "query",
      key: "one",
      value: "refreshed",
      staleTime: 60_000,
      delayMs: 80,
    });
    expect(refreshed.value).toBe("refreshed");
    expect(refreshed.elapsedMs).toBeGreaterThanOrEqual(70);

    await fixture.run("cache", { action: "remove", key: "one" });
    await expect(fixture.run("cache", { action: "peek", key: "one" })).resolves.toEqual({});
    await fixture.run("cache", { action: "set", key: "one", value: "one" });
    await fixture.run("cache", { action: "set", key: "two", value: "two" });
    await fixture.run("cache", { action: "clear" });
    await expect(fixture.run("cache", { action: "peek", key: "two" })).resolves.toEqual({});
  });

  test("covers collection CRUD, nested filters, sorting, search, and multiple collections", async () => {
    await fixture.run("collection", {
      action: "create",
      id: "alpha",
      title: "Payment retry",
      status: "open",
      priority: 2,
      body: "Retry payment with exponential backoff.",
    });
    await fixture.run("collection", {
      action: "create",
      id: "beta",
      title: "Done item",
      status: "done",
      priority: 1,
      body: "Completed work.",
    });
    await expect(
      fixture.run<{ entries: Array<{ id: string }>; total: number }>("collection", {
        action: "list",
        whereStatus: "open",
        sort: "-project.priority",
      }),
    ).resolves.toMatchObject({ entries: [{ id: "alpha" }], total: 1 });
    await expect(
      fixture.run("collection", { action: "count", whereStatus: "open" }),
    ).resolves.toEqual({ count: 1 });
    await expect(
      fixture.run<{ entries: Array<{ id: string; snippet: string }> }>("collection", {
        action: "search",
        query: "payment backoff",
      }),
    ).resolves.toMatchObject({ entries: [{ id: "alpha" }] });

    await fixture.run("collection", {
      action: "update",
      id: "alpha",
      title: "Payment retry fixed",
      status: "done",
      priority: 3,
      body: "Fixed.",
    });
    await expect(fixture.run("collection", { action: "get", id: "alpha" })).resolves.toMatchObject({
      id: "alpha",
      data: { title: "Payment retry fixed", status: "done" },
      body: "Fixed.\n",
    });
    await expect(
      fixture.run("collection", {
        action: "upsert",
        id: "gamma",
        title: "Upserted",
        status: "open",
        priority: 4,
      }),
    ).resolves.toEqual({ id: "gamma", created: true });
    await expect(fixture.run("collection", { action: "remove", id: "beta" })).resolves.toBe(true);

    await fixture.run("collection", {
      collection: "archive",
      action: "create",
      id: "archived",
      title: "Archive entry",
      status: "done",
      priority: 1,
    });
    await expect(
      fixture.run("collection", { collection: "archive", action: "count" }),
    ).resolves.toEqual({ count: 1 });
    await expect(fixture.run("collection", { action: "count" })).resolves.toEqual({ count: 2 });
  });

  test("reconciles hand edits and deletions when collections reopen", async () => {
    await fixture.run("collection", {
      action: "create",
      id: "manual",
      title: "Original",
      status: "open",
      priority: 1,
      body: "Original body",
    });
    const entryPath = join(fixture.toolDir, "notes", "manual.md");
    await writeFile(
      entryPath,
      "---\ntitle: Edited\nstatus: done\nproject:\n  priority: 9\n---\n\nHand edited body\n",
      "utf8",
    );
    await expect(fixture.run("collection", { action: "get", id: "manual" })).resolves.toMatchObject(
      { data: { title: "Edited", status: "done", project: { priority: 9 } } },
    );

    await unlink(entryPath);
    await expect(fixture.run("collection", { action: "get", id: "manual" })).resolves.toBeNull();
  });

  test("runs shell helpers, bounds UTF-8 output, terminates timeouts, and propagates failures", async () => {
    await expect(fixture.run("shell", { action: "exec" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "exec-ok\n",
    });
    await expect(fixture.run("shell", { action: "json" })).resolves.toEqual({ ok: true });
    await expect(fixture.run("shell", { action: "bash" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "bash-ok",
    });
    const bounded = await fixture.run<{ stdout: string }>("shell", { action: "bounded" });
    expect(bounded.stdout).toContain("[rig: output truncated]");
    expect(bounded.stdout).not.toContain("�");

    const timeout = await fixture.runError("shell", { action: "timeout" });
    expect(timeout.errors[0]?.message).toContain("Command timed out after 50ms.");
  });

  test("reuses an invocation session for nested calls and preserves nested error context", async () => {
    const nested = await fixture.run<{ values: number[]; definitionEvaluations: number[] }>(
      "nested",
      { count: 50 },
    );
    expect(nested.values).toHaveLength(50);
    expect(nested.values[0]).toBe(1);
    expect(nested.values[49]).toBe(50);
    expect(new Set(nested.definitionEvaluations)).toEqual(new Set([1]));

    const failure = await fixture.runError("nested", { count: 2, fail: true });
    expect(failure.errors[0]).toMatchObject({
      code: "TOOL_RUN_ERROR",
      message: "Rig tool command failed: stateful.child",
    });
    expect(failure.errors[0]?.details).toMatchObject({ command: "stateful.child" });
  });

  test("keeps lazy SQLite stores absent for no-op commands", async () => {
    const result = await rig.run({ args: ["run", "noop.run"] });
    expect(result.exitCode).toBe(0);
    expect(result.json<SuccessEnvelope<{ ok: boolean }>>().data).toEqual({ ok: true });

    const noopDir = join(rig.rigHomeDir, "rig", "tools", "noop");
    const files = await readdir(noopDir);
    expect(files.filter((file) => file.endsWith(".sqlite") || file.includes(".sqlite-"))).toEqual(
      [],
    );
  });
});
