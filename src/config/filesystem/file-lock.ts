import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { RigErrorClass } from "../../errors/RigError";

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

class FileLockLeaseClass {
  constructor(
    private readonly lockPath: string,
    private readonly owner: LockOwner,
  ) {}

  async release(): Promise<void> {
    try {
      const current = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as {
        token?: unknown;
      };
      if (current.token !== this.owner.token) return;
      await rm(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      if (fileSystemErrors.isMissing(error)) return;
      throw error;
    }
  }
}

class FileSystemErrorsClass {
  isMissing(error: unknown): boolean {
    return this.hasCode(error, "ENOENT");
  }

  isExisting(error: unknown): boolean {
    return this.hasCode(error, "EEXIST");
  }

  isProcessMissing(error: unknown): boolean {
    return this.hasCode(error, "ESRCH");
  }

  private hasCode(error: unknown, code: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code
    );
  }
}

const fileSystemErrors = new FileSystemErrorsClass();

export class BoundedFileLockClass {
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly retryMs: number;
  private readonly lockPath: string;

  constructor(targetPath: string, options: FileLockOptions = {}) {
    this.lockPath = `${targetPath}.lock`;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.staleMs = options.staleMs ?? 30_000;
    this.retryMs = options.retryMs ?? 20;
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  private async acquire(): Promise<FileLockLeaseClass> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    return this.acquireAttempt(Date.now());
  }

  private async acquireAttempt(startedAt: number): Promise<FileLockLeaseClass> {
    const lease = await this.tryAcquire();
    if (lease) return lease;
    await this.recoverStaleLock();
    if (Date.now() - startedAt >= this.timeoutMs) {
      throw new RigErrorClass("CONFIG_INVALID", `Timed out waiting for lock: ${this.lockPath}`, {
        lockPath: this.lockPath,
        timeoutMs: this.timeoutMs,
      });
    }
    await this.sleep(this.retryMs);
    return this.acquireAttempt(startedAt);
  }

  private async tryAcquire(): Promise<FileLockLeaseClass | undefined> {
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };
    try {
      await mkdir(this.lockPath);
    } catch (error) {
      /* v8 ignore else -- lock contention is the only recoverable mkdir failure */
      if (fileSystemErrors.isExisting(error)) return undefined;
      /* v8 ignore next */
      throw error;
    }

    try {
      await writeFile(join(this.lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
      return new FileLockLeaseClass(this.lockPath, owner);
    } catch (error) {
      /* v8 ignore start -- owner writes can only fail through platform I/O faults */
      await rm(this.lockPath, { recursive: true, force: true });
      throw error;
      /* v8 ignore stop */
    }
  }

  private async recoverStaleLock(): Promise<void> {
    let lockStat;
    try {
      lockStat = await stat(this.lockPath);
    } catch (error) {
      /* v8 ignore next -- requires the lock to vanish between mkdir and stat */
      if (fileSystemErrors.isMissing(error)) return;
      /* v8 ignore next */
      throw error;
    }
    if (Date.now() - lockStat.mtimeMs <= this.staleMs) return;

    const owner = await this.readOwner();
    if (owner && this.isOwnerAlive(owner)) return;

    const stalePath = `${this.lockPath}.stale-${randomUUID()}`;
    try {
      await rename(this.lockPath, stalePath);
    } catch (error) {
      /* v8 ignore next -- requires another process to rename the stale lock first */
      if (fileSystemErrors.isMissing(error)) return;
      /* v8 ignore next */
      throw error;
    }
    await rm(stalePath, { recursive: true, force: true });
  }

  private async readOwner(): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.lockPath, "owner.json"), "utf8"),
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

  private isOwnerAlive(owner: LockOwner): boolean {
    if (owner.hostname !== hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return !fileSystemErrors.isProcessMissing(error);
    }
  }

  private async sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export class AtomicFileWriterClass {
  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
