import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RigConfigStoreClass } from "../config/config";
import { RigPathsClass } from "../config/paths";
import { ToolCreatorClass } from "./create";
import {
  cronModuleUrl,
  type CronRegistrar,
  type CronRunResult,
  RigCronServiceClass,
  RigCronWorkerClass,
} from "./cron";

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

  register(params: { path: string; schedule: string; title: string }): Promise<void> {
    this.registered.push(params);
    return Promise.resolve();
  }

  remove(params: { title: string }): Promise<void> {
    this.removed.push(params.title);
    return Promise.resolve();
  }

  validate(params: { schedule: string }): void {
    this.validated.push(params.schedule);
  }
}

const homes = new TestHomeStore();

function rejectNextConfigUpdate(message: string): void {
  vi.spyOn(RigConfigStoreClass.prototype, "update").mockImplementationOnce(
    async function (this: RigConfigStoreClass, mutator) {
      await mutator(await this.read());
      throw new Error(message);
    },
  );
}

afterEach(async () => {
  await homes.cleanup();
});

describe("cron tool commands", () => {
  test("adds, lists, runs, and removes a scheduled command", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });

    await new ToolCreatorClass({ homeDir: home }).create("sample");
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

    const config = await new RigConfigStoreClass({ homeDir: home }).read();
    expect(config.cronJobs).toHaveLength(1);
    expect(await service.list()).toMatchObject({ cronJobs: [added.job] });

    const run = await service.run({ name: "weekly-jira" });
    expect(run.exitCode).toBe(0);
    expect(run.envelope).toMatchObject({
      data: { text: "Jira" },
      errors: [],
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    await new RigCronWorkerClass({ homeDir: home }, {}).scheduled({
      name: "weekly-jira",
      controller: {
        cron: "0 9 * * MON",
        scheduledTime: 123,
        type: "scheduled",
      },
    });
    expect(logs.join("\n")).toContain('"name": "weekly-jira"');
    expect(logs.join("\n")).toContain('"scheduledTime": 123');
    expect(process.exitCode).toBe(0);
    logs.length = 0;
    await new RigCronWorkerClass({ homeDir: home }, {}).scheduled({ name: "weekly-jira" });
    expect(logs.join("\n")).toContain('"schedule": "0 9 * * MON"');

    const removed = await service.remove({ name: "weekly-jira" });
    expect(removed).toMatchObject({
      name: "weekly-jira",
      removed: true,
      workerPath: paths.cronWorkerPath("weekly-jira"),
    });
    expect(registrar.removed).toEqual(["weekly-jira"]);
    expect(existsSync(paths.cronWorkerPath("weekly-jira"))).toBe(false);
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([]);
  });

  test("runs workers through an injected service", async () => {
    const run = vi.fn<() => Promise<CronRunResult>>(async () => ({
      job: { name: "injected", command: "sample.example", schedule: "@daily" },
      envelope: { data: { ok: true }, errors: [] },
      exitCode: 0,
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const worker = new RigCronWorkerClass({}, { service: { run } as never });

    await worker.scheduled({ name: "injected" });

    expect(run).toHaveBeenCalledWith({ name: "injected" });
  });

  test("supports input files and no explicit input", async () => {
    const home = await homes.create();
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });
    const inputPath = join(home, "input.json");

    await new ToolCreatorClass({ homeDir: home }).create("sample");
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
    expect(await service.run({ name: "default-input" })).toMatchObject({
      envelope: { data: { text: "example" }, errors: [] },
      exitCode: 0,
    });
  });

  test("replaces an existing job and worker", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    await service.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      input: '{"text":"old"}',
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const replacement = await service.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@daily",
      input: '{"text":"new"}',
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "tools", "cron.ts")).href,
    });

    expect((await service.list()).cronJobs).toEqual([replacement.job]);
    expect(registrar.registered.map((entry) => entry.schedule)).toEqual(["@weekly", "@daily"]);
    expect(await readFile(paths.cronWorkerPath("weekly-jira"), "utf8")).toContain(
      "/src/tools/cron.ts",
    );
  });

  test("preserves concurrent cron additions", async () => {
    const home = await homes.create();
    const registrar = new FakeCronRegistrar();
    const names = Array.from({ length: 10 }, (_, index) => `job-${index}`);
    await new ToolCreatorClass({ homeDir: home }).create("sample");

    await Promise.all(
      names.map((name) =>
        new RigCronServiceClass({ homeDir: home }, { registrar }).add({
          name,
          command: "sample.example",
          schedule: "@daily",
          moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
        }),
      ),
    );

    expect(
      (await new RigCronServiceClass({ homeDir: home }, { registrar }).list()).cronJobs.map(
        (job) => job.name,
      ),
    ).toEqual(names);
  });

  test("validates cron job names, inputs, command ids, and command input", async () => {
    const home = await homes.create();
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");

    await expect(service.run({ name: "missing" })).rejects.toThrow("Cron job not found: missing");
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
    const service = new RigCronServiceClass({ homeDir: home }, {});

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    await service.add({
      name: "bun-cron",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: cronModuleUrl(import.meta.url),
    });
    await service.remove({ name: "bun-cron" });

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
    const paths = new RigPathsClass({ homeDir: home });
    const remove = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const registrar: CronRegistrar = {
      validate: () => {},
      register: () => Promise.reject(new Error("launchd unavailable")),
      remove,
    };
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });

    await new ToolCreatorClass({ homeDir: home }).create("sample");

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@weekly",
        input: '{"text":"Jira"}',
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("launchd unavailable");

    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([]);
    expect(existsSync(paths.cronWorkerPath("weekly-jira"))).toBe(false);
    expect(remove).toHaveBeenCalledWith({ title: "weekly-jira" });
  });

  test("restores the previous job and worker when replacement registration fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const original = await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      input: '{"text":"old"}',
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const originalWorker = await readFile(workerPath, "utf8");
    const register = vi
      .fn<(params: { path: string; schedule: string; title: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("replacement unavailable"))
      .mockResolvedValueOnce();
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: { validate: () => {}, register, remove: () => Promise.resolve() } },
    );

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@daily",
        input: '{"text":"new"}',
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "tools", "cron.ts")).href,
      }),
    ).rejects.toThrow("replacement unavailable");

    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([
      original.job,
    ]);
    expect(await readFile(workerPath, "utf8")).toBe(originalWorker);
    expect(register.mock.calls.map((call) => call[0].schedule)).toEqual(["@daily", "@weekly"]);
  });

  test("preserves the configured job and worker when removal fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const original = await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const originalWorker = await readFile(workerPath, "utf8");
    const service = new RigCronServiceClass(
      { homeDir: home },
      {
        registrar: {
          validate: () => {},
          register: () => Promise.resolve(),
          remove: () => Promise.reject(new Error("launchd remove unavailable")),
        },
      },
    );

    await expect(service.remove({ name: "weekly-jira" })).rejects.toThrow(
      "launchd remove unavailable",
    );
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([
      original.job,
    ]);
    expect(await readFile(workerPath, "utf8")).toBe(originalWorker);
  });

  test("restores local state and OS registration when removal persistence fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const original = await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const originalWorker = await readFile(workerPath, "utf8");
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });
    rejectNextConfigUpdate("config unavailable");

    await expect(service.remove({ name: "weekly-jira" })).rejects.toThrow("config unavailable");
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([
      original.job,
    ]);
    expect(await readFile(workerPath, "utf8")).toBe(originalWorker);
    expect(registrar.removed).toEqual(["weekly-jira"]);
    expect(registrar.registered).toEqual([
      { path: workerPath, schedule: "@weekly", title: "weekly-jira" },
    ]);
  });

  test("restores the removed config job when worker deletion fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const original = await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const service = new RigCronServiceClass(
      { homeDir: home },
      {
        registrar: {
          validate: () => {},
          register: () => Promise.resolve(),
          remove: async () => {
            await rm(workerPath);
            await mkdir(workerPath);
            await writeFile(join(workerPath, "keep"), "force deletion failure\n", "utf8");
          },
        },
      },
    );

    await expect(service.remove({ name: "weekly-jira" })).rejects.toMatchObject({
      code: "CRON_ERROR",
      message: "Cron state rollback was incomplete.",
    });
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([
      original.job,
    ]);
  });

  test("preserves a concurrent cron replacement during removal restoration", async () => {
    const home = await homes.create();
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });
    const replacement = { name: "weekly-jira", command: "sample.example", schedule: "@daily" };
    const store = new RigConfigStoreClass({ homeDir: home });
    await store.update((config) => ({ ...config, cronJobs: [replacement] }));
    const transaction = (
      service as unknown as {
        transaction: Record<
          "remove" | "restoreRemovedJob" | "snapshot",
          (...params: unknown[]) => unknown
        >;
      }
    ).transaction;

    await transaction.restoreRemovedJob({ ...replacement, schedule: "@weekly" });
    const workerPath = new RigPathsClass({ homeDir: home }).cronWorkerPath("missing");
    expect(await transaction.snapshot({ workerPath })).toEqual({ workerSource: undefined });
    expect(await transaction.remove({ snapshot: {}, workerPath, name: "missing" })).toBe(false);

    expect((await store.read()).cronJobs).toEqual([replacement]);
  });

  test("does not restore a failed replacement over missing or newer config state", async () => {
    const home = await homes.create();
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );
    const store = new RigConfigStoreClass({ homeDir: home });
    const failedJob = {
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
    };
    const transaction = (
      service as unknown as {
        transaction: {
          restoreReplacedJob(job: typeof failedJob, previousJob?: typeof failedJob): Promise<void>;
        };
      }
    ).transaction;

    await transaction.restoreReplacedJob(failedJob);
    expect((await store.read()).cronJobs).toEqual([]);

    const newerJob = { ...failedJob, schedule: "@daily" };
    await store.update((config) => ({ ...config, cronJobs: [newerJob] }));
    await transaction.restoreReplacedJob(failedJob, { ...failedJob, schedule: "@monthly" });
    expect((await store.read()).cronJobs).toEqual([newerJob]);
  });

  test("rolls back a new worker when local replacement persistence fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    rejectNextConfigUpdate("config unavailable");

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@weekly",
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
      }),
    ).rejects.toThrow("config unavailable");
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([]);
    expect(existsSync(paths.cronWorkerPath("weekly-jira"))).toBe(false);
    expect(registrar.registered).toEqual([]);
    expect(registrar.removed).toEqual([]);
  });

  test("leaves config unchanged when worker replacement cannot start", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );
    const store = new RigConfigStoreClass({ homeDir: home });
    await store.ensure();
    await writeFile(paths.cronDir, "blocks cron directory creation\n", "utf8");
    const job = { name: "weekly-jira", command: "sample.example", schedule: "@weekly" };
    const transaction = (
      service as unknown as {
        transaction: {
          replace(params: {
            snapshot: { workerSource?: string };
            workerPath: string;
            workerSource: string;
            job: typeof job;
          }): Promise<void>;
        };
      }
    ).transaction;

    await expect(
      transaction.replace({
        snapshot: {},
        workerPath: join(paths.cronDir, "weekly-jira.ts"),
        workerSource: "worker\n",
        job,
      }),
    ).rejects.toThrow(/EEXIST|ENOTDIR|not a directory/);
    expect((await store.read()).cronJobs).toEqual([]);
  });

  test("restores config after local removal failure without a configured job", async () => {
    const home = await homes.create();
    const registrar = new FakeCronRegistrar();
    const service = new RigCronServiceClass({ homeDir: home }, { registrar });

    await new RigConfigStoreClass({ homeDir: home }).ensure();
    rejectNextConfigUpdate("config unavailable");

    await expect(service.remove({ name: "missing" })).rejects.toThrow("config unavailable");
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([]);
    expect(registrar.removed).toEqual(["missing"]);
    expect(registrar.registered).toEqual([]);
  });

  test("reports local rollback failures after registration fails", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const originalWorker = await readFile(workerPath, "utf8");
    const register = vi
      .fn<(params: { path: string; schedule: string; title: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("replacement unavailable"))
      .mockResolvedValueOnce();
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: { validate: () => {}, register, remove: () => Promise.resolve() } },
    );
    const originalUpdate = RigConfigStoreClass.prototype.update;
    const update = vi.spyOn(RigConfigStoreClass.prototype, "update");
    update.mockImplementationOnce(async function (this: RigConfigStoreClass, mutator) {
      update.mockRejectedValueOnce(new Error("config restore unavailable"));
      return originalUpdate.call(this, mutator);
    });

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@daily",
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "tools", "cron.ts")).href,
      }),
    ).rejects.toMatchObject({
      code: "CRON_ERROR",
      details: { rollbackErrors: ["config restore unavailable"] },
    });
    expect(await readFile(workerPath, "utf8")).toBe(originalWorker);
  });

  test("reports incomplete rollback while restoring local replacement state", async () => {
    const home = await homes.create();
    const paths = new RigPathsClass({ homeDir: home });
    const initialService = new RigCronServiceClass(
      { homeDir: home },
      { registrar: new FakeCronRegistrar() },
    );

    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const original = await initialService.add({
      name: "weekly-jira",
      command: "sample.example",
      schedule: "@weekly",
      moduleUrl: pathToFileURL(join(process.cwd(), "src", "cli.ts")).href,
    });
    const workerPath = paths.cronWorkerPath("weekly-jira");
    const originalWorker = await readFile(workerPath, "utf8");
    const register = vi
      .fn<(params: { path: string; schedule: string; title: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("replacement unavailable"))
      .mockRejectedValueOnce("restore unavailable");
    const service = new RigCronServiceClass(
      { homeDir: home },
      { registrar: { validate: () => {}, register, remove: () => Promise.resolve() } },
    );

    await expect(
      service.add({
        name: "weekly-jira",
        command: "sample.example",
        schedule: "@daily",
        moduleUrl: pathToFileURL(join(process.cwd(), "src", "tools", "cron.ts")).href,
      }),
    ).rejects.toMatchObject({
      code: "CRON_ERROR",
      message: "Cron state rollback was incomplete.",
      details: {
        cause: "replacement unavailable",
        rollbackErrors: ["restore unavailable"],
      },
    });
    expect((await new RigConfigStoreClass({ homeDir: home }).read()).cronJobs).toEqual([
      original.job,
    ]);
    expect(await readFile(workerPath, "utf8")).toBe(originalWorker);
  });
});
