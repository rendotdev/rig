import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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

export const FileLockOperation = Schema.Literals(["acquire", "release", "operation"]);
export type FileLockOperation = typeof FileLockOperation.Type;

export class FileLockError extends Schema.TaggedErrorClass<FileLockError>()("FileLockError", {
  operation: FileLockOperation,
  lockPath: Schema.String,
  cause: Schema.Defect(),
}) {}

class FileLockContentionError extends Schema.TaggedErrorClass<FileLockContentionError>()(
  "FileLockContentionError",
  { lockPath: Schema.String },
) {}

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

export const FileSystemErrorsSingleton = {
  isMissing,
  isExisting,
  isProcessMissing,
};

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

class BoundedFileLockLeaseRepo {
  public constructor(
    protected readonly deps: BoundedFileLockDeps,
    protected readonly lockPath: string,
    protected readonly timeoutMs: number,
    protected readonly staleMs: number,
    protected readonly retryMs: number,
  ) {}

  public async release(owner: LockOwner): Promise<void> {
    try {
      const current = JSON.parse(
        await this.deps.readFile(this.deps.join(this.lockPath, "owner.json"), "utf8"),
      ) as { token?: unknown };
      if (current.token !== owner.token) return;
      await this.deps.rm(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      if (this.deps.fsErrors.isMissing({ error })) return;
      throw error;
    }
  }

  private async tryAcquire(): Promise<LockOwner | undefined> {
    const owner: LockOwner = {
      token: this.deps.randomUUID(),
      pid: this.deps.getProcessPid(),
      hostname: this.deps.hostname(),
      acquiredAt: this.deps.timestamp(),
    };
    try {
      await this.deps.mkdir(this.lockPath);
    } catch (error) {
      /* v8 ignore else -- lock contention is the only recoverable mkdir failure */
      if (this.deps.fsErrors.isExisting({ error })) return undefined;
      /* v8 ignore next */
      throw error;
    }

    try {
      await this.deps.writeFile(
        this.deps.join(this.lockPath, "owner.json"),
        `${JSON.stringify(owner)}\n`,
        "utf8",
      );
      return owner;
    } catch (error) {
      /* v8 ignore start -- owner writes can only fail through platform I/O faults */
      await this.deps.rm(this.lockPath, { recursive: true, force: true });
      throw error;
      /* v8 ignore stop */
    }
  }

  private async readOwner(): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(
        await this.deps.readFile(this.deps.join(this.lockPath, "owner.json"), "utf8"),
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
    if (owner.hostname !== this.deps.hostname()) return false;
    try {
      this.deps.killProcess(owner.pid, 0);
      return true;
    } catch (error) {
      return !this.deps.fsErrors.isProcessMissing({ error });
    }
  }

  private async recoverStaleLock(): Promise<boolean> {
    let lockStat;
    try {
      lockStat = await this.deps.stat(this.lockPath);
    } catch (error) {
      /* v8 ignore next -- requires the lock to vanish between mkdir and stat */
      if (this.deps.fsErrors.isMissing({ error })) return false;
      /* v8 ignore next */
      throw error;
    }
    if (this.deps.now() - lockStat.mtimeMs <= this.staleMs) return false;

    const owner = await this.readOwner();
    if (owner && this.isOwnerAlive(owner)) return false;

    const stalePath = `${this.lockPath}.stale-${this.deps.randomUUID()}`;
    try {
      await this.deps.rename(this.lockPath, stalePath);
    } catch (error) {
      /* v8 ignore next -- requires another process to rename the stale lock first */
      if (this.deps.fsErrors.isMissing({ error })) return false;
      /* v8 ignore next */
      throw error;
    }
    await this.deps.rm(stalePath, { recursive: true, force: true });
    return true;
  }

  private timeoutError(): RigErrorClass {
    return new RigErrorClass("CONFIG_INVALID", `Timed out waiting for lock: ${this.lockPath}`, {
      lockPath: this.lockPath,
      timeoutMs: this.timeoutMs,
    });
  }

  public acquire(): Effect.Effect<LockOwner, FileLockError> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.tryPromise({
        try: () => this.deps.mkdir(this.deps.dirname(this.lockPath), { recursive: true }),
        catch: (cause) =>
          new FileLockError({ operation: "acquire", lockPath: this.lockPath, cause }),
      });
      const startedAt = this.deps.now();
      const attempt = Effect.tryPromise({
        try: async () => {
          const owner = await this.tryAcquire();
          if (owner) return owner;
          if (await this.recoverStaleLock()) {
            const recoveredOwner = await this.tryAcquire();
            /* v8 ignore else -- another process can win only during cross-process contention */
            if (recoveredOwner) return recoveredOwner;
          }
          if (this.deps.now() - startedAt >= this.timeoutMs) throw this.timeoutError();
          await this.deps.sleep(this.retryMs);
          throw new FileLockContentionError({ lockPath: this.lockPath });
        },
        catch: (cause) =>
          cause instanceof FileLockContentionError
            ? cause
            : new FileLockError({ operation: "acquire", lockPath: this.lockPath, cause }),
      });
      const retries = Math.max(1, Math.ceil(this.timeoutMs / Math.max(1, this.retryMs)) + 1);
      return yield* Effect.retry(attempt, {
        schedule: Schedule.recurs(retries),
        while: (error) => error instanceof FileLockContentionError,
      }).pipe(
        Effect.catch((error) =>
          error instanceof FileLockContentionError
            ? Effect.fail(
                new FileLockError({
                  operation: "acquire",
                  lockPath: this.lockPath,
                  cause: this.timeoutError(),
                }),
              )
            : Effect.fail(error),
        ),
      );
    });
  }
}

export class BoundedFileLockRepo {
  public static readonly defaultConstruction = {
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
  };
  protected readonly params: (typeof BoundedFileLockRepo.defaultConstruction)["params"];
  protected readonly deps: (typeof BoundedFileLockRepo.defaultConstruction)["deps"];

  public constructor(
    props: typeof BoundedFileLockRepo.defaultConstruction = BoundedFileLockRepo.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
  }

  public create(params: { targetPath: string; options?: FileLockOptions }) {
    const deps = this.deps;
    const lockPath = `${params.targetPath}.lock`;
    const timeoutMs = params.options?.timeoutMs ?? this.params.timeoutMs;
    const staleMs = params.options?.staleMs ?? this.params.staleMs;
    const retryMs = params.options?.retryMs ?? this.params.retryMs;
    const lease = new BoundedFileLockLeaseRepo(deps, lockPath, timeoutMs, staleMs, retryMs);
    const acquire = lease.acquire();

    function effect<T>(runParams: {
      operation: () => T | Promise<T>;
    }): Effect.Effect<T, FileLockError> {
      return Effect.acquireUseRelease(
        acquire,
        () =>
          Effect.tryPromise({
            try: async () => await runParams.operation(),
            catch: (cause) => new FileLockError({ operation: "operation", lockPath, cause }),
          }),
        (owner) =>
          Effect.tryPromise({
            try: () => lease.release(owner),
            catch: (cause) => new FileLockError({ operation: "release", lockPath, cause }),
          }),
      ).pipe(Effect.withSpan("FileLockService.withLock", { attributes: { lockPath } }));
    }

    function run<T>(runParams: { operation: () => T | Promise<T> }): Promise<T> {
      return Effect.runPromise(effect(runParams).pipe(Effect.mapError((error) => error.cause)));
    }

    return { effect, run };
  }
}

type FileLockServiceShape = Readonly<{
  withLock: <Result>(params: {
    targetPath: string;
    options?: FileLockOptions;
    operation: () => Result | Promise<Result>;
  }) => Effect.Effect<Result, FileLockError>;
}>;

export class FileLockService extends Context.Service<FileLockService, FileLockServiceShape>()(
  "@rendotdev/rig/settings/FileLockService",
) {
  public static readonly makeLayer = (
    implementation: BoundedFileLockRepo,
  ): Layer.Layer<FileLockService> =>
    Layer.succeed(FileLockService, {
      withLock: (params) => implementation.create(params).effect({ operation: params.operation }),
    });

  public static readonly layer = FileLockService.makeLayer(new BoundedFileLockRepo());
}

export const BoundedFileLock = new BoundedFileLockRepo();

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
