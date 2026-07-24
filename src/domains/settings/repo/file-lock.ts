import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { defineRepo, defineSingleton } from "../../../define.ts";
import { RigErrorClass } from "../../../providers/errors/index.ts";

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

// ─── Module-level dep implementations ────────────────────────────────────────

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissing(params: { error: unknown }): boolean {
  return hasCode(params.error, "ENOENT");
}

function isExisting(params: { error: unknown }): boolean {
  return hasCode(params.error, "EEXIST");
}

function isProcessMissing(params: { error: unknown }): boolean {
  return hasCode(params.error, "ESRCH");
}

function getProcessPid(): number {
  return process.pid;
}

function killProcess(pid: number, signal: number): void {
  process.kill(pid, signal);
}

function now(): number {
  return Date.now();
}

function timestamp(): string {
  return new Date().toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ─── FileSystemErrorsSingleton ────────────────────────────────────────────────

export const FileSystemErrorsSingleton = defineSingleton({
  params: {},
  deps: {},
  isMissing,
  isExisting,
  isProcessMissing,
});

// ─── BoundedFileLockRepo ──────────────────────────────────────────────────────

export type BoundedFileLockDeps = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  writeFile: (path: string, content: string, encoding: "utf8") => Promise<void>;
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
  randomUUID: () => string;
  hostname: () => string;
  getProcessPid: () => number;
  killProcess: (pid: number, signal: number) => void;
  now: () => number;
  timestamp: () => string;
  sleep: (ms: number) => Promise<void>;
  fsErrors: typeof FileSystemErrorsSingleton;
};

export class BoundedFileLockRepo extends defineRepo({
  params: {
    timeoutMs: 5_000,
    staleMs: 30_000,
    retryMs: 20,
  },
  deps: {
    mkdir: mkdir as unknown as BoundedFileLockDeps["mkdir"],
    readFile: readFile as unknown as BoundedFileLockDeps["readFile"],
    rename: rename as unknown as BoundedFileLockDeps["rename"],
    rm: rm as unknown as BoundedFileLockDeps["rm"],
    stat: stat as unknown as BoundedFileLockDeps["stat"],
    writeFile: writeFile as unknown as BoundedFileLockDeps["writeFile"],
    dirname,
    join,
    randomUUID: randomUUID as unknown as BoundedFileLockDeps["randomUUID"],
    hostname,
    getProcessPid,
    killProcess,
    now,
    timestamp,
    sleep,
    fsErrors: FileSystemErrorsSingleton,
  } as BoundedFileLockDeps,
}) {
  public create(params: { targetPath: string; options?: FileLockOptions }) {
    const deps = this.deps;
    const lockPath = `${params.targetPath}.lock`;
    const timeoutMs = params.options?.timeoutMs ?? this.params.timeoutMs;
    const staleMs = params.options?.staleMs ?? this.params.staleMs;
    const retryMs = params.options?.retryMs ?? this.params.retryMs;

    async function releaseLease(owner: LockOwner): Promise<void> {
      try {
        const current = JSON.parse(
          await deps.readFile(deps.join(lockPath, "owner.json"), "utf8"),
        ) as { token?: unknown };
        if (current.token !== owner.token) return;
        await deps.rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if (deps.fsErrors.isMissing({ error })) return;
        throw error;
      }
    }

    async function tryAcquire(): Promise<LockOwner | undefined> {
      const owner: LockOwner = {
        token: deps.randomUUID(),
        pid: deps.getProcessPid(),
        hostname: deps.hostname(),
        acquiredAt: deps.timestamp(),
      };
      try {
        await deps.mkdir(lockPath);
      } catch (error) {
        /* v8 ignore else -- lock contention is the only recoverable mkdir failure */
        if (deps.fsErrors.isExisting({ error })) return undefined;
        /* v8 ignore next */
        throw error;
      }

      try {
        await deps.writeFile(
          deps.join(lockPath, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          "utf8",
        );
        return owner;
      } catch (error) {
        /* v8 ignore start -- owner writes can only fail through platform I/O faults */
        await deps.rm(lockPath, { recursive: true, force: true });
        throw error;
        /* v8 ignore stop */
      }
    }

    async function readOwner(): Promise<LockOwner | undefined> {
      try {
        const parsed = JSON.parse(
          await deps.readFile(deps.join(lockPath, "owner.json"), "utf8"),
        ) as Partial<LockOwner>;
        if (
          typeof parsed.token !== "string" ||
          typeof parsed.pid !== "number" ||
          typeof parsed.hostname !== "string" ||
          typeof parsed.acquiredAt !== "string"
        ) {
          return undefined;
        }
        return parsed as LockOwner;
      } catch {
        return undefined;
      }
    }

    function isOwnerAlive(owner: LockOwner): boolean {
      if (owner.hostname !== deps.hostname()) return false;
      try {
        deps.killProcess(owner.pid, 0);
        return true;
      } catch (error) {
        return !deps.fsErrors.isProcessMissing({ error });
      }
    }

    async function recoverStaleLock(): Promise<void> {
      let lockStat;
      try {
        lockStat = await deps.stat(lockPath);
      } catch (error) {
        /* v8 ignore next -- requires the lock to vanish between mkdir and stat */
        if (deps.fsErrors.isMissing({ error })) return;
        /* v8 ignore next */
        throw error;
      }
      if (deps.now() - lockStat.mtimeMs <= staleMs) return;

      const owner = await readOwner();
      if (owner && isOwnerAlive(owner)) return;

      const stalePath = `${lockPath}.stale-${deps.randomUUID()}`;
      try {
        await deps.rename(lockPath, stalePath);
      } catch (error) {
        /* v8 ignore next -- requires another process to rename the stale lock first */
        if (deps.fsErrors.isMissing({ error })) return;
        /* v8 ignore next */
        throw error;
      }
      await deps.rm(stalePath, { recursive: true, force: true });
    }

    async function acquireAttempt(startedAt: number): Promise<LockOwner> {
      const owner = await tryAcquire();
      if (owner) return owner;
      await recoverStaleLock();
      if (deps.now() - startedAt >= timeoutMs) {
        throw new RigErrorClass("CONFIG_INVALID", `Timed out waiting for lock: ${lockPath}`, {
          lockPath,
          timeoutMs,
        });
      }
      await deps.sleep(retryMs);
      return acquireAttempt(startedAt);
    }

    async function acquire(): Promise<LockOwner> {
      await deps.mkdir(deps.dirname(lockPath), { recursive: true });
      return acquireAttempt(deps.now());
    }

    async function run<T>(runParams: { operation: () => T | Promise<T> }): Promise<T> {
      const owner = await acquire();
      try {
        return await runParams.operation();
      } finally {
        await releaseLease(owner);
      }
    }

    return { run };
  }
}

export const BoundedFileLock = new BoundedFileLockRepo();

// ─── AtomicFileWriterRepo ─────────────────────────────────────────────────────

export type AtomicFileWriterDeps = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (path: string, options?: { force?: boolean }) => Promise<void>;
  writeFile: (path: string, content: string, encoding: "utf8") => Promise<void>;
  dirname: (path: string) => string;
  randomUUID: () => string;
  getProcessPid: () => number;
};

export class AtomicFileWriterRepo extends defineRepo({
  params: {},
  deps: {
    mkdir: mkdir as unknown as AtomicFileWriterDeps["mkdir"],
    rename: rename as unknown as AtomicFileWriterDeps["rename"],
    rm: rm as unknown as AtomicFileWriterDeps["rm"],
    writeFile: writeFile as unknown as AtomicFileWriterDeps["writeFile"],
    dirname,
    randomUUID: randomUUID as unknown as AtomicFileWriterDeps["randomUUID"],
    getProcessPid,
  } as AtomicFileWriterDeps,
}) {
  public async write(params: { path: string; content: string }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(params.path), { recursive: true });
    const temporaryPath = `${params.path}.tmp-${this.deps.getProcessPid()}-${this.deps.randomUUID()}`;
    try {
      await this.deps.writeFile(temporaryPath, params.content, "utf8");
      await this.deps.rename(temporaryPath, params.path);
    } catch (error) {
      await this.deps.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export const AtomicFileWriter = new AtomicFileWriterRepo();

// ─── BoundedFileLockClass (class-free constructible adapter) ──────────────────

export interface BoundedFileLockClass {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

function boundedFileLockRun<T>(
  this: { resource: ReturnType<typeof BoundedFileLock.create> },
  operation: () => T | Promise<T>,
): Promise<T> {
  return this.resource.run({ operation });
}

export const BoundedFileLockClass: new (
  targetPath: string,
  options?: FileLockOptions,
) => BoundedFileLockClass = (function () {
  function BoundedFileLockAdapter(
    this: { resource: ReturnType<typeof BoundedFileLock.create> },
    targetPath: string,
    options: FileLockOptions = {},
  ): void {
    this.resource = BoundedFileLock.create({ targetPath, options });
  }

  Object.defineProperty(BoundedFileLockAdapter.prototype, "run", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: boundedFileLockRun,
  });

  return BoundedFileLockAdapter;
})() as unknown as new (targetPath: string, options?: FileLockOptions) => BoundedFileLockClass;

// ─── AtomicFileWriterClass (class-free constructible adapter) ─────────────────

export interface AtomicFileWriterClass {
  write(path: string, content: string): Promise<void>;
}

export const AtomicFileWriterClass: new () => AtomicFileWriterClass = (function () {
  function AtomicFileWriterAdapter(): void {}

  Object.defineProperty(AtomicFileWriterAdapter.prototype, "write", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function write(path: string, content: string): Promise<void> {
      return AtomicFileWriter.write({ path, content });
    },
  });

  return AtomicFileWriterAdapter;
})() as unknown as new () => AtomicFileWriterClass;
