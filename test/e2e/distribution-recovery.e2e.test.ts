import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { RigE2EHarnessClass, RigE2EHarnessFactoryClass } from "./harness";

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CronJob = {
  name: string;
  command: string;
  schedule: string;
  input?: unknown;
};

class NpmPackResultClass {
  constructor(private readonly params: { stdout: string }) {}

  public filename(): string {
    const parsed = JSON.parse(this.params.stdout) as unknown;
    const candidate = Array.isArray(parsed)
      ? parsed[0]
      : typeof parsed === "object" && parsed !== null
        ? Object.values(parsed)[0]
        : undefined;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("filename" in candidate) ||
      typeof candidate.filename !== "string"
    ) {
      throw new Error(`npm pack returned no package filename: ${this.params.stdout}`);
    }
    return candidate.filename;
  }
}

class ProcessRunnerClass {
  public async run(params: {
    command: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<SpawnResult> {
    const child = spawn(params.command[0]!, params.command.slice(1), {
      cwd: params.cwd,
      env: { ...this.environment(), ...params.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), params.timeoutMs ?? 60_000);
    try {
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit(code ?? 1));
      });
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timeout);
    }
  }

  private environment(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  }
}

class InstalledDistributionClass {
  public rootDir = "";
  public consumerDir = "";
  public entrypoint = "";
  public bunPath = "";
  public tarballPath = "";
  private readonly processes = new ProcessRunnerClass();

  public async setup(): Promise<void> {
    this.rootDir = await mkdtemp(join(tmpdir(), "rig-distribution-e2e-"));
    this.consumerDir = join(this.rootDir, "consumer");
    await mkdir(this.consumerDir, { recursive: true });
    await writeFile(
      join(this.consumerDir, "package.json"),
      `${JSON.stringify({ name: "rig-e2e-consumer", private: true }, null, 2)}\n`,
      "utf8",
    );

    const packed = await this.processes.run({
      command: ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", this.rootDir],
      cwd: repositoryRoot,
    });
    if (packed.exitCode !== 0) throw new Error(packed.stderr || packed.stdout);
    this.tarballPath = join(
      this.rootDir,
      new NpmPackResultClass({ stdout: packed.stdout }).filename(),
    );

    const installed = await this.processes.run({
      command: ["npm", "install", "--no-audit", "--no-fund", this.tarballPath],
      cwd: this.consumerDir,
      timeoutMs: 120_000,
    });
    if (installed.exitCode !== 0) throw new Error(installed.stderr || installed.stdout);

    this.entrypoint = join(
      this.consumerDir,
      "node_modules",
      "@rendotdev",
      "rig",
      "dist",
      "rig.mjs",
    );
    this.bunPath = join(this.consumerDir, "node_modules", ".bin", "bun");
    if (!existsSync(this.entrypoint)) {
      throw new Error(`Installed Rig entrypoint is missing: ${this.entrypoint}`);
    }
  }

  public harnessFactory(): RigE2EHarnessFactoryClass {
    return new RigE2EHarnessFactoryClass({ cliPath: this.entrypoint, runtime: "node" });
  }

  public async cleanup(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }
}

class DistributionFixtureClass {
  public readonly cronEntrypoint = resolve(
    testDirectory,
    "fixtures",
    "distribution",
    "fake-cron-preload.ts",
  );
  public readonly collectionTool = resolve(
    testDirectory,
    "fixtures",
    "distribution",
    "collection-tool.ts",
  );

  public async readCollectionTool(): Promise<string> {
    return readFile(this.collectionTool, "utf8");
  }
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..", "..");
const expectedVersion = (
  JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version: string }
).version;
const distribution = new InstalledDistributionClass();
const fixture = new DistributionFixtureClass();
const processes = new ProcessRunnerClass();
const homes: RigE2EHarnessClass[] = [];

async function createHarness(params: { cron?: boolean } = {}): Promise<RigE2EHarnessClass> {
  const factory = params.cron
    ? new RigE2EHarnessFactoryClass({ cliPath: fixture.cronEntrypoint, runtime: "bun" })
    : distribution.harnessFactory();
  const harness = await factory.create();
  homes.push(harness);
  return harness;
}

function cronEnvironment(params: Record<string, string> = {}): Record<string, string> {
  return {
    RIG_DISTRIBUTION_ENTRY: distribution.entrypoint,
    ...params,
  };
}

describe("installed Rig distribution and recovery", () => {
  beforeAll(async () => {
    await distribution.setup();
  }, 150_000);

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => home.cleanup()));
  });

  afterAll(async () => {
    await distribution.cleanup();
  });

  test("accepts npm 11 and npm 12 packed-artifact metadata", () => {
    expect(new NpmPackResultClass({ stdout: '[{"filename":"npm-11.tgz"}]' }).filename()).toBe(
      "npm-11.tgz",
    );
    expect(
      new NpmPackResultClass({
        stdout: '{"@rendotdev/rig":{"filename":"npm-12.tgz"}}',
      }).filename(),
    ).toBe("npm-12.tgz");
    expect(() => new NpmPackResultClass({ stdout: "{}" }).filename()).toThrow(
      "no package filename",
    );
  });

  test("packs and installs a consumer-ready CLI with generated runtime support", async () => {
    const rig = await createHarness();
    const version = await rig.run({ args: ["--version"] });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(expectedVersion);

    expect((await rig.run({ args: ["init"] })).exitCode).toBe(0);
    expect((await rig.run({ args: ["create", "consumer"] })).exitCode).toBe(0);
    const run = await rig.run({ args: ["run", "consumer.example", "installed"] });
    expect(run.exitCode).toBe(0);
    expect(run.json<{ data: { text: string }; errors: [] }>().data.text).toBe("installed");

    const typecheck = await rig.run({ args: ["typecheck", "consumer"], timeoutMs: 30_000 });
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.json<{ ok: boolean }>().ok).toBe(true);

    const installedDistDir = dirname(distribution.entrypoint);
    const installedPackage = JSON.parse(
      await readFile(
        join(distribution.consumerDir, "node_modules", "@rendotdev", "rig", "package.json"),
        "utf8",
      ),
    ) as { bin?: Record<string, string> };
    expect(installedPackage.bin).toEqual({ rig: "dist/rig.mjs" });
    const installedFiles = await readdir(installedDistDir);
    expect(installedFiles).toContain("rig.mjs");
    expect(installedFiles.some((file) => file.endsWith(".js"))).toBe(false);
    const installedJavaScript = (
      await Promise.all(
        installedFiles
          .filter((file) => file.endsWith(".mjs"))
          .map((file) => readFile(join(installedDistDir, file), "utf8")),
      )
    ).join("\n");
    expect(installedJavaScript).not.toContain(join(repositoryRoot, "node_modules", "typescript"));
    expect(installedJavaScript).toContain('import("bun:sqlite")');

    for (const file of ["sdk.ts", "types.d.ts", "globals.d.ts", "tsconfig.tools.json"]) {
      expect(existsSync(join(rig.rigHomeDir, "rig", "runtime", file))).toBe(true);
    }
    const globals = await rig.read(join(rig.rigHomeDir, "rig", "runtime", "globals.d.ts"));
    expect(globals).toContain("RigToolFactory");
    expect(globals).toContain("RigTool");
  }, 45_000);

  test("bootstraps an installed Node invocation into the packaged Bun runtime", async () => {
    expect(existsSync(distribution.bunPath)).toBe(true);
    const rootDir = await mkdtemp(join(tmpdir(), "rig-node-bootstrap-e2e-"));
    try {
      const result = await processes.run({
        command: ["node", distribution.entrypoint, "--version"],
        cwd: distribution.consumerDir,
        env: {
          HOME: rootDir,
          RIG_HOME: rootDir,
          RIG_AGENT_SYNC: "0",
          RIG_UPDATE_CHECK: "0",
        },
      });
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(expectedVersion);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("exports the supported built compatibility surface", async () => {
    const installed = (await import(
      `${pathToFileURL(distribution.entrypoint).href}?e2e=exports`
    )) as Record<string, unknown>;
    for (const name of [
      "CliApplicationClass",
      "CliApplication",
      "BunRuntimeBootstrapClass",
      "BunRuntimeBootstrap",
      "RigCronWorkerClass",
      "RigCronWorker",
      "isCliEntrypoint",
    ]) {
      expect(installed[name], `missing built export ${name}`).toBeDefined();
    }
  });

  test("migrates a legacy directory and rewrites its default registry", async () => {
    const rig = await createHarness();
    const legacyDir = join(rig.rigHomeDir, ".rig");
    await mkdir(join(legacyDir, "tools", "legacy"), { recursive: true });
    await writeFile(
      join(legacyDir, "rig.json"),
      `${JSON.stringify({
        version: 1,
        baseRegistryDir: "~/.rig/tools",
        customRegistries: [],
        cronJobs: [],
      })}\n`,
      "utf8",
    );
    await writeFile(join(legacyDir, "tools", "legacy", "marker.txt"), "kept\n", "utf8");

    const result = await rig.run({ args: ["init"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rig moved its home folder:");
    expect(existsSync(legacyDir)).toBe(false);
    expect(
      await readFile(join(rig.rigHomeDir, "rig", "tools", "legacy", "marker.txt"), "utf8"),
    ).toBe("kept\n");
    const config = JSON.parse(await rig.read(join(rig.rigHomeDir, "rig", "rig.json"))) as {
      baseRegistryDir: string;
    };
    expect(config.baseRegistryDir).toBe("~/rig/tools");
  });

  test("shows a manual migration conflict once and preserves both directories", async () => {
    const rig = await createHarness();
    const oldDir = join(rig.rigHomeDir, ".rig");
    const currentDir = join(rig.rigHomeDir, "rig");
    await mkdir(join(oldDir, "tools"), { recursive: true });
    await mkdir(currentDir, { recursive: true });
    await writeFile(join(oldDir, "rig.json"), "{}\n", "utf8");
    await writeFile(join(currentDir, "keep.txt"), "current\n", "utf8");

    const first = await rig.run({ args: ["init"] });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("migration needs your attention");
    expect(existsSync(join(oldDir, "rig.json"))).toBe(true);
    expect(existsSync(join(currentDir, "keep.txt"))).toBe(true);

    const second = await rig.run({ args: ["init"] });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain("migration needs your attention");
    const promptState = await rig.read(join(currentDir, "migration-prompts.json"));
    expect(promptState).toContain("v0.0.19-home-directory");
  });

  test("preserves concurrent registry and cron writers without corrupting config", async () => {
    const rig = await createHarness();
    await rig.run({ args: ["create", "sample"] });
    const registryDirs = Array.from({ length: 8 }, (_, index) =>
      join(rig.rootDir, `registry-${index}`),
    );
    const registryResults = await Promise.all(
      registryDirs.map((path) => rig.run({ args: ["registry", "create", path] })),
    );
    expect(registryResults.every((result) => result.exitCode === 0)).toBe(true);

    const cronRig = await createHarness({ cron: true });
    await cronRig.run({ args: ["create", "sample"], env: cronEnvironment() });
    const cronLog = join(cronRig.rootDir, "fake-cron.jsonl");
    const cronResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        cronRig.run({
          args: ["cron", "add", `job-${index}`, "sample.example", "@daily"],
          env: cronEnvironment({ RIG_FAKE_CRON_LOG: cronLog }),
        }),
      ),
    );
    expect(cronResults.every((result) => result.exitCode === 0)).toBe(true);

    const registryConfig = JSON.parse(await rig.read(join(rig.rigHomeDir, "rig", "rig.json"))) as {
      customRegistries: string[];
    };
    expect(registryConfig.customRegistries.toSorted()).toEqual(registryDirs.toSorted());
    const cronConfig = JSON.parse(
      await cronRig.read(join(cronRig.rigHomeDir, "rig", "rig.json")),
    ) as { cronJobs: CronJob[] };
    expect(cronConfig.cronJobs.map((job) => job.name).toSorted()).toEqual(
      Array.from({ length: 8 }, (_, index) => `job-${index}`),
    );
    for (const job of cronConfig.cronJobs) {
      expect(existsSync(join(cronRig.rigHomeDir, "rig", "cron", `${job.name}.ts`))).toBe(true);
    }
  }, 45_000);

  test("generates cron workers and rolls failed replacement and removal back", async () => {
    const rig = await createHarness({ cron: true });
    await rig.run({ args: ["create", "sample"], env: cronEnvironment() });
    const logPath = join(rig.rootDir, "fake-cron.jsonl");
    const baseEnv = cronEnvironment({ RIG_FAKE_CRON_LOG: logPath });
    const added = await rig.run({
      args: ["cron", "add", "daily", "sample.example", "@daily", "--input", '{"text":"old"}'],
      env: baseEnv,
    });
    expect(added.exitCode).toBe(0);
    const workerPath = join(rig.rigHomeDir, "rig", "cron", "daily.ts");
    const originalWorker = await rig.read(workerPath);
    expect(originalWorker).toContain('"cron"');
    expect(originalWorker).toContain('"daily"');
    expect(originalWorker).toContain("--install=fallback");

    const replacement = await rig.run({
      args: ["cron", "add", "daily", "sample.example", "@weekly", "--input", '{"text":"new"}'],
      env: { ...baseEnv, RIG_FAKE_CRON_FAIL_REGISTER_SCHEDULE: "@weekly" },
    });
    expect(replacement.exitCode).toBe(1);
    expect(replacement.stderr).toContain("INTERNAL_ERROR: fake register failure: @weekly");
    expect(await rig.read(workerPath)).toBe(originalWorker);
    let config = JSON.parse(await rig.read(join(rig.rigHomeDir, "rig", "rig.json"))) as {
      cronJobs: CronJob[];
    };
    expect(config.cronJobs).toEqual([
      { name: "daily", command: "sample.example", schedule: "@daily", input: { text: "old" } },
    ]);

    const removal = await rig.run({
      args: ["cron", "remove", "daily"],
      env: { ...baseEnv, RIG_FAKE_CRON_FAIL_REMOVE_TITLE: "daily" },
    });
    expect(removal.exitCode).toBe(1);
    expect(existsSync(workerPath)).toBe(true);
    config = JSON.parse(await rig.read(join(rig.rigHomeDir, "rig", "rig.json"))) as {
      cronJobs: CronJob[];
    };
    expect(config.cronJobs).toHaveLength(1);

    const removed = await rig.run({ args: ["cron", "remove", "daily"], env: baseEnv });
    expect(removed.exitCode).toBe(0);
    expect(existsSync(workerPath)).toBe(false);
    const log = await rig.read(logPath);
    expect(log).toContain('"schedule":"@weekly"');
    expect(log.match(/"schedule":"@daily"/g)?.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("reports corrupt config and automatically rebuilds a corrupt collection index", async () => {
    const rig = await createHarness();
    await rig.run({ args: ["init"] });
    const configPath = join(rig.rigHomeDir, "rig", "rig.json");
    await writeFile(configPath, "{broken\n", "utf8");
    const corruptedConfig = await rig.run({ args: ["config", "show"] });
    expect(corruptedConfig.exitCode).toBe(1);
    expect(corruptedConfig.stderr).toContain("CONFIG_INVALID: Config is not valid JSON");
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
        baseRegistryDir: "~/rig/tools",
        customRegistries: [],
        cronJobs: [],
      })}\n`,
      "utf8",
    );
    expect((await rig.run({ args: ["doctor"] })).exitCode).toBe(0);

    await writeFile(join(rig.rigHomeDir, "rig", "update-check.json"), "not json\n", "utf8");
    const updateCache = await rig.run({ args: ["init"], env: { RIG_UPDATE_CHECK: "1" } });
    expect(updateCache.exitCode).toBe(0);

    await rig.writeTool({ name: "documents", source: await fixture.readCollectionTool() });
    const add = await rig.run({
      args: ["run", "documents.add", "title=First Note", "body=Body"],
    });
    expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
    const indexPath = join(rig.rigHomeDir, "rig", "tools", "documents", "notes", ".index.sqlite");
    await writeFile(indexPath, "corrupted sqlite\n", "utf8");
    const recovered = await Promise.all(
      Array.from({ length: 8 }, () => rig.run({ args: ["run", "documents.list"] })),
    );
    for (const result of recovered) {
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json<{ data: { ids: string[] } }>().data.ids).toEqual(["first-note"]);
    }
    expect((await readFile(indexPath)).subarray(0, 15).toString()).toBe("SQLite format 3");
  }, 30_000);

  test("creates a portable POSIX development shim and removes it safely", async () => {
    if (process.platform === "win32") return;
    const rig = await createHarness();
    const binDir = join(rig.rootDir, "bin with spaces");
    const link = await rig.run({
      args: ["dev", "link", "--bin-dir", binDir],
      cwd: repositoryRoot,
    });
    expect(link.exitCode).toBe(0);
    const shimPath = join(binDir, "rig");
    await chmod(shimPath, 0o755);
    const shim = await processes.run({
      command: [shimPath, "--version"],
      cwd: rig.projectDir,
      env: {
        HOME: rig.homeDir,
        RIG_HOME: rig.rigHomeDir,
        RIG_AGENT_SYNC: "0",
        RIG_UPDATE_CHECK: "0",
      },
    });
    expect(shim.exitCode).toBe(0);
    expect(shim.stdout.trim()).toBe(expectedVersion);

    const status = await rig.run({
      args: ["dev", "status", "--bin-dir", binDir],
      cwd: repositoryRoot,
    });
    expect(status.json<{ exists: boolean; pointsToCurrentRepo: boolean }>().exists).toBe(true);
    expect(status.json<{ pointsToCurrentRepo: boolean }>().pointsToCurrentRepo).toBe(true);
    const unlink = await rig.run({
      args: ["dev", "unlink", "--bin-dir", binDir],
      cwd: repositoryRoot,
    });
    expect(unlink.exitCode).toBe(0);
    expect(existsSync(shimPath)).toBe(false);
  });
});
