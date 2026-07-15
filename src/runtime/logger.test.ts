import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogRotationLockClass, type LogRotationLockDeps, RigLoggerFactoryClass } from "./logger";

class LoggerWorkspaceStore {
  private readonly homes: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-logger-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

class LogRotationLockDepsFakeClass implements LogRotationLockDeps {
  readonly madeDirectories: string[] = [];
  readonly removedPaths: string[] = [];
  readonly renamedPaths: Array<[string, string]> = [];
  readonly waits: number[] = [];
  makeDirectoryErrors: unknown[] = [];
  readStatusErrors: unknown[] = [];
  nowValues: number[] = [0];
  mtimeMs = 0;

  now(): number {
    return this.nowValues.length > 1 ? (this.nowValues.shift() ?? 0) : (this.nowValues[0] ?? 0);
  }

  wait(_buffer: Int32Array, _index: number, _value: number, timeout: number): string {
    this.waits.push(timeout);
    return "ok";
  }

  makeDirectory(path: string): void {
    this.madeDirectories.push(path);
    const error = this.makeDirectoryErrors.shift();
    if (error !== undefined) throw error;
  }

  readStatus(_path: string): { mtimeMs: number } {
    const error = this.readStatusErrors.shift();
    if (error !== undefined) throw error;
    return { mtimeMs: this.mtimeMs };
  }

  rename(from: string, to: string): void {
    this.renamedPaths.push([from, to]);
  }

  remove(path: string): void {
    this.removedPaths.push(path);
  }
}

class ChildProcessExitReaderClass {
  async read(child: ReturnType<typeof spawn>): Promise<number | null> {
    return await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  }
}

const workspaces = new LoggerWorkspaceStore();
const fixedLogNow = () => Date.parse("2026-07-01T00:00:00.000Z");

afterEach(async () => {
  await workspaces.cleanup();
});

describe("rig logger", () => {
  test("bounds rotation-lock waiting and surfaces unexpected acquisition failures", () => {
    const timeoutDeps = new LogRotationLockDepsFakeClass();
    timeoutDeps.makeDirectoryErrors = [{ code: "EEXIST" }, { code: "EEXIST" }];
    timeoutDeps.nowValues = [0, 0, 20];
    const timeoutLock = new LogRotationLockClass(
      { logDir: "/logs", waitTimeoutMs: 20, staleAfterMs: 30_000 },
      timeoutDeps,
    );
    expect(timeoutLock.run(() => undefined)).toBe(false);
    expect(timeoutDeps.waits).toEqual([]);

    for (const error of ["permission denied", { code: 13 }]) {
      const failureDeps = new LogRotationLockDepsFakeClass();
      failureDeps.makeDirectoryErrors = [error];
      const failureLock = new LogRotationLockClass({ logDir: "/logs" }, failureDeps);
      let thrown: unknown;
      try {
        failureLock.run(() => undefined);
      } catch (failure) {
        thrown = failure;
      }
      expect(thrown).toBe(error);
    }
  });

  test("recovers stale locks and tolerates competing recovery races", () => {
    const staleDeps = new LogRotationLockDepsFakeClass();
    staleDeps.makeDirectoryErrors = [{ code: "EEXIST" }];
    staleDeps.nowValues = [40_000];
    const staleLock = new LogRotationLockClass({ logDir: "/logs" }, staleDeps);
    expect(staleLock.run(() => undefined)).toBe(true);
    expect(staleDeps.renamedPaths).toHaveLength(1);
    expect(staleDeps.removedPaths).toHaveLength(2);

    for (const code of ["ENOENT", "EEXIST"]) {
      const raceDeps = new LogRotationLockDepsFakeClass();
      raceDeps.makeDirectoryErrors = [{ code: "EEXIST" }];
      raceDeps.readStatusErrors = [{ code }];
      const raceLock = new LogRotationLockClass({ logDir: "/logs" }, raceDeps);
      expect(raceLock.run(() => undefined)).toBe(true);
      expect(raceDeps.waits).toEqual([10]);
    }

    const failureDeps = new LogRotationLockDepsFakeClass();
    failureDeps.makeDirectoryErrors = [{ code: "EEXIST" }];
    failureDeps.readStatusErrors = [new Error("status failed")];
    const failureLock = new LogRotationLockClass({ logDir: "/logs" }, failureDeps);
    expect(() => failureLock.run(() => undefined)).toThrow("status failed");
  });

  test("writes prefixed pino logs, rolls files, and removes expired files", async () => {
    const home = await workspaces.create();
    const logDir = join(home, "rig", ".logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "rig-old.log"), "old\n", "utf8");
    await utimes(
      join(logDir, "rig-old.log"),
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );

    const factory = new RigLoggerFactoryClass({
      homeDir: home,
      level: "trace",
      maxFileSizeBytes: 180,
      retentionDays: 7,
      now: fixedLogNow,
    });
    factory.app().debug("Debug app line.");
    factory.app("test").info({ ok: true }, "App log line.");
    factory.tool("sample", "echo").info({ key: "value" }, "Tool log line.");
    factory.tool("sample", "echo").warn("Another tool log line that rolls the active log.");
    factory.tool("sample", "echo").error(new Error("boom"), "Tool error line.");

    new RigLoggerFactoryClass({
      homeDir: home,
      level: "info",
      maxFileSizeBytes: 180,
      retentionDays: 7,
      now: fixedLogNow,
    })
      .app("second")
      .info("Second factory line.");

    const entries = (await readdir(logDir)).toSorted();
    expect(entries).not.toContain("rig-old.log");
    expect(entries).toContain("rig.log");
    expect(entries.some((entry) => entry.startsWith("rig-2026-07-01T00-00-00-000Z"))).toBe(true);
    expect(entries.some((entry) => entry.includes("-1.log"))).toBe(true);

    const output = (
      await Promise.all(entries.map((entry) => readFile(join(logDir, entry), "utf8")))
    ).join("\n");
    expect(output).toContain('"prefix":"rig:test"');
    expect(output).toContain('"prefix":"tool:sample.echo"');
    expect(output).toContain("Tool log line.");
    expect(output).toContain('"type":"Error"');
  });

  test("supports disabled logging and environment configuration", async () => {
    const disabledHome = await workspaces.create();
    new RigLoggerFactoryClass({
      homeDir: disabledHome,
      env: { RIG_LOG: "0" } as NodeJS.ProcessEnv,
    })
      .app("disabled")
      .info("This should not be written.");
    expect(existsSync(join(disabledHome, "rig", ".logs"))).toBe(false);

    const envHome = await workspaces.create();
    const logDir = join(envHome, "custom-logs");
    new RigLoggerFactoryClass({
      homeDir: envHome,
      env: {
        RIG_LOG_DIR: logDir,
        RIG_LOG_LEVEL: "debug",
        RIG_LOG_MAX_BYTES: "1000",
        RIG_LOG_RETENTION_DAYS: "7",
      } as NodeJS.ProcessEnv,
    })
      .app("env")
      .debug("Environment configured debug line.");
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain(
      "Environment configured debug line.",
    );

    const fallbackHome = await workspaces.create();
    new RigLoggerFactoryClass({
      homeDir: fallbackHome,
      env: {
        RIG_LOG_MAX_BYTES: "not-a-number",
        RIG_LOG_RETENTION_DAYS: "not-a-number",
      } as NodeJS.ProcessEnv,
    })
      .app("fallback")
      .info("Fallback configured line.");
    expect(await readFile(join(fallbackHome, "rig", ".logs", "rig.log"), "utf8")).toContain(
      "Fallback configured line.",
    );
  });

  test("keeps the active log during retention and recovers an abandoned rotation lock", async () => {
    const home = await workspaces.create();
    const logDir = join(home, "logs");
    const lockPath = join(logDir, ".rig.log.rotation.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(logDir, "rig.log"), "active\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(join(logDir, "rig.log"), old, old);

    new RigLoggerFactoryClass({ logDir }).app("recovery").info("Recovered logging.");

    expect(existsSync(lockPath)).toBe(false);
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain("active\n");
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain("Recovered logging.");
  });

  test("preserves every record while separate processes rotate the same log", async () => {
    const home = await workspaces.create();
    const logDir = join(home, "logs");
    const loggerUrl = new URL("./logger.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, processIndex) => {
      const source = `
        import { RigLoggerFactoryClass } from ${JSON.stringify(loggerUrl)};
        const logger = new RigLoggerFactoryClass({
          logDir: ${JSON.stringify(logDir)},
          maxFileSizeBytes: 500,
          retentionDays: 7,
        }).app("child");
        for (let line = 0; line < 20; line++) logger.info("record-${processIndex}-" + line);
      `;
      return spawn("bun", ["-e", source], { stdio: "pipe" });
    });

    const exits = await Promise.all(
      children.map(
        (child) =>
          new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          }),
      ),
    );
    expect(exits).toEqual([0, 0, 0, 0]);

    const entries = (await readdir(logDir)).filter((entry) => entry.endsWith(".log"));
    const output = (
      await Promise.all(entries.map((entry) => readFile(join(logDir, entry), "utf8")))
    ).join("\n");
    const records = new Set(output.match(/record-\d+-\d+/g));
    expect(records.size).toBe(80);
    expect(existsSync(join(logDir, ".rig.log.rotation.lock"))).toBe(false);
  });

  test("rechecks active size after a competing process rotates while waiting", async () => {
    const home = await workspaces.create();
    const logDir = join(home, "logs");
    const lockPath = join(logDir, ".rig.log.rotation.lock");
    const activePath = join(logDir, "rig.log");
    const logger = new RigLoggerFactoryClass({ logDir, maxFileSizeBytes: 100 }).app("race");
    await writeFile(activePath, "x".repeat(200), "utf8");
    await mkdir(lockPath);

    const source = `
      import { rm, writeFile } from "node:fs/promises";
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(${JSON.stringify(activePath)}, "", "utf8");
      await rm(${JSON.stringify(lockPath)}, { recursive: true, force: true });
    `;
    const child = spawn("bun", ["-e", source], { stdio: "pipe" });
    logger.info("Written after competing rotation.");

    expect(await new ChildProcessExitReaderClass().read(child)).toBe(0);
    expect(await readFile(activePath, "utf8")).toContain("Written after competing rotation.");
    expect(existsSync(lockPath)).toBe(false);
  });
});
