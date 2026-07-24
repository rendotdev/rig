import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  AtomicFileWriterClass,
  AtomicFileWriter,
  AtomicFileWriterRepo,
  BoundedFileLockClass,
  BoundedFileLock,
  BoundedFileLockRepo,
  FileSystemErrorsSingleton,
  type AtomicFileWriterDeps,
  type BoundedFileLockDeps,
} from "./file-lock";

// ─── Module-level test helpers ────────────────────────────────────────────────

function testGetProcessPid(): number {
  return process.pid;
}

function testKillProcess(pid: number, signal: number): void {
  process.kill(pid, signal);
}

function testNow(): number {
  return Date.now();
}

function testTimestamp(): string {
  return new Date().toISOString();
}

function testSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function noopSleep(): Promise<void> {}

async function throwRenameError(): Promise<void> {
  throw new Error("rename failed");
}

// ─── Shared test infrastructure ───────────────────────────────────────────────

class LockTestDirectories {
  private readonly paths: string[] = [];

  async create(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-file-lock-test-"));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

const directories = new LockTestDirectories();

afterEach(async () => {
  await directories.cleanup();
});

async function createStaleLock(target: string, ownerSource: string): Promise<string> {
  const lockPath = `${target}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), ownerSource, "utf8");
  await utimes(lockPath, new Date(0), new Date(0));
  return lockPath;
}

function makeProductionLockDeps(overrides?: Partial<BoundedFileLockDeps>): BoundedFileLockDeps {
  return {
    mkdir: mkdir as unknown as BoundedFileLockDeps["mkdir"],
    readFile: readFile as unknown as BoundedFileLockDeps["readFile"],
    rename: rename as unknown as BoundedFileLockDeps["rename"],
    rm: rm as unknown as BoundedFileLockDeps["rm"],
    stat: stat as unknown as BoundedFileLockDeps["stat"],
    writeFile: writeFile as unknown as BoundedFileLockDeps["writeFile"],
    dirname,
    join,
    randomUUID,
    hostname,
    getProcessPid: testGetProcessPid,
    killProcess: testKillProcess,
    now: testNow,
    timestamp: testTimestamp,
    sleep: testSleep,
    fsErrors: FileSystemErrorsSingleton,
    ...overrides,
  };
}

// ─── FileSystemErrorsSingleton ────────────────────────────────────────────────

describe("FileSystemErrorsSingleton", () => {
  test("identifies ENOENT errors as missing", () => {
    const e = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(FileSystemErrorsSingleton.isMissing({ error: e })).toBe(true);
    expect(FileSystemErrorsSingleton.isExisting({ error: e })).toBe(false);
    expect(FileSystemErrorsSingleton.isProcessMissing({ error: e })).toBe(false);
  });

  test("identifies EEXIST errors as existing", () => {
    const e = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    expect(FileSystemErrorsSingleton.isExisting({ error: e })).toBe(true);
    expect(FileSystemErrorsSingleton.isMissing({ error: e })).toBe(false);
  });

  test("identifies ESRCH errors as process missing", () => {
    const e = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    expect(FileSystemErrorsSingleton.isProcessMissing({ error: e })).toBe(true);
    expect(FileSystemErrorsSingleton.isMissing({ error: e })).toBe(false);
  });

  test("returns false for non-errors and errors without a matching code", () => {
    expect(FileSystemErrorsSingleton.isMissing({ error: null })).toBe(false);
    expect(FileSystemErrorsSingleton.isMissing({ error: "ENOENT" })).toBe(false);
    expect(FileSystemErrorsSingleton.isMissing({ error: 42 })).toBe(false);
    expect(FileSystemErrorsSingleton.isMissing({ error: new Error("no code") })).toBe(false);
  });
});

// ─── BoundedFileLockRepo ──────────────────────────────────────────────────────

describe("BoundedFileLockRepo", () => {
  test("create returns a lock resource whose run uses named params", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lock = BoundedFileLock.create({ targetPath: target });

    const result = await lock.run({ operation: () => "done" });
    expect(result).toBe("done");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("create accepts per-lock options and releases correctly", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lock = BoundedFileLock.create({ targetPath: target, options: { retryMs: 5 } });

    await lock.run({ operation: () => undefined });
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("create returns independent resources for different target paths", async () => {
    const directory = await directories.create();
    const lock1 = BoundedFileLock.create({ targetPath: join(directory, "a.json") });
    const lock2 = BoundedFileLock.create({ targetPath: join(directory, "b.json") });

    const [r1, r2] = await Promise.all([
      lock1.run({ operation: () => "a" }),
      lock2.run({ operation: () => "b" }),
    ]);

    expect(r1).toBe("a");
    expect(r2).toBe("b");
  });

  test("builder injects clock and sleep to produce a deterministic timeout", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;
    await mkdir(lockPath);

    let tick = 0;
    const Service = new BoundedFileLockRepo({
      params: { timeoutMs: 50, staleMs: 30_000, retryMs: 0 },
      deps: makeProductionLockDeps({
        now: function now() {
          tick += 60;
          return tick;
        },
        sleep: noopSleep,
      }),
    });

    const lock = Service.create({ targetPath: target });
    await expect(lock.run({ operation: () => "done" })).rejects.toThrow(/Timed out/);

    await rm(lockPath, { recursive: true, force: true });
  });
});

// ─── AtomicFileWriterRepo ─────────────────────────────────────────────────────

describe("AtomicFileWriterRepo", () => {
  test("write accepts named params and creates nested directories", async () => {
    const directory = await directories.create();
    const target = join(directory, "nested", "sub", "state.json");

    await AtomicFileWriter.write({ path: target, content: "hello\n" });
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  test("builder calls the rm dep when rename throws", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    let cleanedPath: string | undefined;

    const Service = new AtomicFileWriterRepo({
      params: {},
      deps: {
        mkdir: mkdir as unknown as AtomicFileWriterDeps["mkdir"],
        writeFile: writeFile as unknown as AtomicFileWriterDeps["writeFile"],
        rename: throwRenameError,
        rm: async (path: string): Promise<void> => {
          cleanedPath = path;
        },
        dirname,
        randomUUID,
        getProcessPid: testGetProcessPid,
      },
    });

    await expect(Service.write({ path: target, content: "data\n" })).rejects.toThrow(
      "rename failed",
    );
    expect(cleanedPath?.startsWith(target)).toBe(true);
    expect(cleanedPath?.includes(".tmp-")).toBe(true);
  });
});

// ─── Adapter compatibility: bounded file lock ─────────────────────────────────

describe("bounded file lock", () => {
  test("releases after operation failures and missing lock directories", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;
    const lock = new BoundedFileLockClass(target);

    await expect(
      lock.run(() => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      lock.run(async () => {
        await rm(lockPath, { recursive: true });
      }),
    ).resolves.toBeUndefined();
  });

  test("does not release a lock whose ownership token changed", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;

    await new BoundedFileLockClass(target).run(async () => {
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ token: "replacement" })}\n`,
        "utf8",
      );
    });

    expect(existsSync(lockPath)).toBe(true);
    await rm(lockPath, { recursive: true });
  });

  test("propagates malformed lease metadata during release", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;

    await expect(
      new BoundedFileLockClass(target).run(async () => {
        await writeFile(join(lockPath, "owner.json"), "not json\n", "utf8");
      }),
    ).rejects.toThrow(/JSON|Unexpected token/);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("recovers stale locks with malformed, incomplete, and remote owners", async () => {
    const directory = await directories.create();
    const owners = [
      "not json\n",
      `${JSON.stringify({ token: "missing-fields" })}\n`,
      `${JSON.stringify({
        token: "remote",
        pid: process.pid,
        hostname: `${hostname()}-remote`,
        acquiredAt: new Date(0).toISOString(),
      })}\n`,
    ];

    await Promise.all(
      owners.map(async (owner, index) => {
        const target = join(directory, `state-${index}.json`);
        const lockPath = await createStaleLock(target, owner);
        await new BoundedFileLockClass(target, { staleMs: 1 }).run(() => undefined);
        expect(existsSync(lockPath)).toBe(false);
      }),
    );
  });
});

// ─── Adapter compatibility: atomic file writer ────────────────────────────────

describe("atomic file writer", () => {
  test("atomically replaces files and cleans temporary files after rename failures", async () => {
    const directory = await directories.create();
    const writer = new AtomicFileWriterClass();
    const target = join(directory, "state.json");
    await writer.write(target, "first\n");
    await writer.write(target, "second\n");
    expect(await readFile(target, "utf8")).toBe("second\n");

    const directoryTarget = join(directory, "cannot-replace");
    await mkdir(directoryTarget);
    await expect(writer.write(directoryTarget, "content\n")).rejects.toThrow(/rename|directory/);
    expect((await readdir(directory)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });
});
