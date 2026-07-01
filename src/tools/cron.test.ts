import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RigConfigStore } from "../config/config";
import { RigPaths } from "../config/paths";
import { ToolCreator } from "./create";
import { cronModuleUrl, type CronRegistrar, RigCronService, RigCronWorker } from "./cron";

class TestHomeStore {
  private readonly homes: string[] = [];
  private readonly originalExitCode = process.exitCode;

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-cron-test-home-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    process.exitCode = this.originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

class FakeCronRegistrar implements CronRegistrar {
  readonly registered: { path: string; schedule: string; title: string }[] = [];
  readonly removed: string[] = [];
  readonly validated: string[] = [];

  register(path: string, schedule: string, title: string): Promise<void> {
    this.registered.push({ path, schedule, title });
    return Promise.resolve();
  }

  remove(title: string): Promise<void> {
    this.removed.push(title);
    return Promise.resolve();
  }

  validate(schedule: string): void {
    this.validated.push(schedule);
  }
}

const homes = new TestHomeStore();

afterEach(async () => {
  await homes.cleanup();
});

describe("cron tool commands", () => {
  test("adds, lists, runs, and removes a scheduled command", async () => {
    const home = await homes.create();
    const paths = new RigPaths({ homeDir: home });
    const registrar = new FakeCronRegistrar();
    const service = new RigCronService({ homeDir: home }, registrar);

    await new ToolCreator({ homeDir: home }).create("sample");
    const added = await service.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "0 9 * * MON",
      input: '{"text":"Jira"}',
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });

    expect(added.job).toMatchObject({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "0 9 * * MON",
      input: { text: "Jira" },
    });
    expect(registrar.validated).toEqual(["0 9 * * MON"]);
    expect(registrar.registered).toEqual([
      {
        path: paths.cronWorkerPath("weekly-jira"),
        schedule: "0 9 * * MON",
        title: "weekly-jira",
      },
    ]);

    const worker = await readFile(paths.cronWorkerPath("weekly-jira"), "utf8");
    expect(worker).toContain("--install=fallback");
    expect(worker).toContain('"cron"');
    expect(worker).toContain('"run"');
    expect(worker).toContain("weekly-jira");

    const config = await new RigConfigStore({ homeDir: home }).read();
    expect(config.cronJobs).toHaveLength(1);
    expect(await service.list()).toMatchObject({ cronJobs: [added.job] });

    const run = await service.run("weekly-jira");
    expect(run.exitCode).toBe(0);
    expect(run.envelope).toMatchObject({
      data: { text: "Jira" },
      errors: [],
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    await new RigCronWorker({ homeDir: home }).scheduled("weekly-jira", {
      cron: "0 9 * * MON",
      scheduledTime: 123,
      type: "scheduled",
    });
    expect(logs.join("\n")).toContain('"name": "weekly-jira"');
    expect(logs.join("\n")).toContain('"scheduledTime": 123');
    expect(process.exitCode).toBe(0);
    logs.length = 0;
    await new RigCronWorker({ homeDir: home }).scheduled("weekly-jira");
    expect(logs.join("\n")).toContain('"schedule": "0 9 * * MON"');

    const removed = await service.remove("weekly-jira");
    expect(removed).toMatchObject({
      name: "weekly-jira",
      removed: true,
      workerPath: paths.cronWorkerPath("weekly-jira"),
    });
    expect(registrar.removed).toEqual(["weekly-jira"]);
    expect(existsSync(paths.cronWorkerPath("weekly-jira"))).toBe(false);
    expect((await new RigConfigStore({ homeDir: home }).read()).cronJobs).toEqual([]);
  });

  test("supports input files and no explicit input", async () => {
    const home = await homes.create();
    const registrar = new FakeCronRegistrar();
    const service = new RigCronService({ homeDir: home }, registrar);
    const inputPath = join(home, "input.json");

    await new ToolCreator({ homeDir: home }).create("sample");
    await writeFile(inputPath, '{"text":"from file"}\n', "utf8");

    const fromFile = await service.add({
      name: "from-file",
      command: "sample.example",
      schedule: "@weekly",
      inputFile: inputPath,
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const defaultInput = await service.add({
      name: "default-input",
      command: "sample.example",
      schedule: "@daily",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });

    expect((await service.list()).cronJobs.map((job) => job.name)).toEqual([
      "default-input",
      "from-file",
    ]);
    expect(fromFile.job.input).toEqual({ text: "from file" });
    expect(defaultInput.job).not.toHaveProperty("input");
    expect(await service.run("default-input")).toMatchObject({
      envelope: { data: { text: "example" }, errors: [] },
      exitCode: 0,
    });
  });

  test("validates cron job names, inputs, command ids, and command input", async () => {
    const home = await homes.create();
    const service = new RigCronService({ homeDir: home }, new FakeCronRegistrar());

    await new ToolCreator({ homeDir: home }).create("sample");

    await expect(service.run("missing")).rejects.toThrow("Cron job not found: missing");
    await expect(
      service.add({
        name: "bad name",
        command: "sample.example",
        schedule: "@weekly",
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("Cron job names may only contain");
    await expect(
      service.add({
        name: "bad-command",
        command: "sample",
        schedule: "@weekly",
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("Command id must use <tool>.<command>");
    await expect(
      service.add({
        name: "double-input",
        command: "sample.example",
        schedule: "@weekly",
        input: '{"text":"inline"}',
        inputFile: join(home, "input.json"),
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("Use --input or --input-file");
    await expect(
      service.add({
        name: "bad-input",
        command: "sample.example",
        schedule: "@weekly",
        input: '{"text":123}',
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("Cron command validation failed: sample.example");
  });

  test("uses Bun cron registration and schedule validation", async () => {
    const home = await homes.create();
    const originalBun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
    const cron = Object.assign(
      vi.fn<(path: string, schedule: string, title: string) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      {
        parse: vi.fn<(expression: string) => Date | null>(
          () => new Date("2026-07-01T00:00:00.000Z"),
        ),
        remove: vi.fn<(title: string) => Promise<void>>(() => Promise.resolve()),
      },
    );
    vi.stubGlobal("Bun", { ...(originalBun as Record<string, unknown>), cron });
    const service = new RigCronService({ homeDir: home });

    await new ToolCreator({ homeDir: home }).create("sample");
    await service.add({
      name: "bun-cron",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: cronModuleUrl(import.meta.url),
    });
    await service.remove("bun-cron");

    expect(cron.parse).toHaveBeenCalledWith("@weekly");
    expect(cron).toHaveBeenCalledWith(expect.any(String), "@weekly", "bun-cron");
    expect(cron.remove).toHaveBeenCalledWith("bun-cron");

    cron.parse.mockReturnValueOnce(null);
    await expect(
      service.add({
        name: "no-future-runs",
        command: "sample.example",
        schedule: "@never",
        moduleUrl: cronModuleUrl(import.meta.url),
      }),
    ).rejects.toThrow("Cron schedule has no future runs");
  });

  test("rolls back config and worker when OS registration fails", async () => {
    const home = await homes.create();
    const paths = new RigPaths({ homeDir: home });
    const registrar: CronRegistrar = {
      validate: () => {},
      register: () => Promise.reject(new Error("launchd unavailable")),
      remove: () => Promise.resolve(),
    };
    const service = new RigCronService({ homeDir: home }, registrar);

    await new ToolCreator({ homeDir: home }).create("sample");

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@weekly",
        input: '{"text":"Jira"}',
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("launchd unavailable");

    expect((await new RigConfigStore({ homeDir: home }).read()).cronJobs).toEqual([]);
    expect(existsSync(paths.cronWorkerPath("weekly-jira"))).toBe(false);
  });
});
