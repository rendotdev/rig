import { dirname, join } from "node:path";
import { Context, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { RigError } from "../errors/rig-error";
import { FileLockPlatformService } from "./file-lock-platform";
import { FileLockRuntimeService } from "./file-lock-runtime";

export type FileLockOptions = { timeoutMs?: number; staleMs?: number; retryMs?: number };

type LockOwner = { token: string; pid: number; hostname: string; acquiredAt: string };

const FileLockOperation = Schema.Literals(["acquire", "release", "operation"]);
type FileLockOperation = typeof FileLockOperation.Type;

export class FileLockError extends Schema.TaggedErrorClass<FileLockError>()("FileLockError", {
  operation: FileLockOperation,
  lockPath: Schema.String,
  cause: Schema.Defect(),
}) {}

class FileLockContentionError extends Schema.TaggedErrorClass<FileLockContentionError>()(
  "FileLockContentionError",
  { lockPath: Schema.String },
) {}

class FileLockConfigService extends Context.Service<
  FileLockConfigService,
  {
    readonly timeoutMs: number;
    readonly staleMs: number;
    readonly retryMs: number;
  }
>()("@rendotdev/rig/settings/FileLockConfigService", {
  make: Effect.gen(function* () {
    const timeoutMs = 5_000;
    const staleMs = 30_000;
    const retryMs = 20;
    return { timeoutMs, staleMs, retryMs } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockConfigService, FileLockConfigService.make);
}

class FileLockOwnerService extends Context.Service<
  FileLockOwnerService,
  {
    readonly read: (lockPath: string) => Effect.Effect<LockOwner | undefined>;
    readonly tryAcquire: (lockPath: string) => Effect.Effect<LockOwner | undefined, FileLockError>;
  }
>()("@rendotdev/rig/settings/FileLockOwnerService", {
  make: Effect.gen(function* () {
    const platform = yield* FileLockPlatformService;
    const runtime = yield* FileLockRuntimeService;
    const hasCode = (error: unknown, code: string) => {
      const cause = Predicate.hasProperty(error, "cause") ? error.cause : error;
      return Predicate.hasProperty(cause, "code") && cause.code === code;
    };
    const mapAcquireError = (lockPath: string) => (cause: unknown) =>
      new FileLockError({ operation: "acquire", lockPath, cause });
    const read = Effect.fn("FileLockOwnerService.read")(function* (lockPath: string) {
      return yield* platform.readText(join(lockPath, "owner.json")).pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => JSON.parse(content) as Partial<LockOwner>,
            catch: () => undefined,
          }),
        ),
        Effect.map((owner) =>
          typeof owner.token === "string" &&
          typeof owner.pid === "number" &&
          typeof owner.hostname === "string" &&
          typeof owner.acquiredAt === "string"
            ? (owner as LockOwner)
            : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );
    });
    const tryAcquire = Effect.fn("FileLockOwnerService.tryAcquire")(function* (lockPath: string) {
      const created = yield* platform.makeDirectory(lockPath, false).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          hasCode(error, "EEXIST")
            ? Effect.succeed(false)
            : Effect.fail(mapAcquireError(lockPath)(error)),
        ),
      );
      if (!created) return undefined;
      const owner: LockOwner = {
        token: yield* runtime.randomUuid,
        pid: yield* runtime.processPid,
        hostname: yield* runtime.hostName,
        acquiredAt: yield* runtime.timestamp,
      };
      return yield* platform
        .writeText(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`)
        .pipe(
          Effect.as(owner),
          Effect.tapError(() => platform.removeDirectory(lockPath)),
          Effect.mapError(mapAcquireError(lockPath)),
        );
    });
    return { read, tryAcquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockOwnerService, FileLockOwnerService.make);
}

class FileLockOwnerLivenessService extends Context.Service<
  FileLockOwnerLivenessService,
  { readonly isAlive: (owner: LockOwner) => Effect.Effect<boolean> }
>()("@rendotdev/rig/settings/FileLockOwnerLivenessService", {
  make: Effect.gen(function* () {
    const runtime = yield* FileLockRuntimeService;
    const hasCode = (error: unknown, code: string) => {
      const cause = Predicate.hasProperty(error, "cause") ? error.cause : error;
      return Predicate.hasProperty(cause, "code") && cause.code === code;
    };
    const isAlive = Effect.fn("FileLockOwnerLivenessService.isAlive")(function* (owner: LockOwner) {
      if (owner.hostname !== (yield* runtime.hostName)) return false;
      return yield* runtime.killProcess(owner.pid, 0).pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.succeed(!hasCode(error, "ESRCH"))),
      );
    });
    return { isAlive } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    FileLockOwnerLivenessService,
    FileLockOwnerLivenessService.make,
  );
}

class FileLockReleaseService extends Context.Service<
  FileLockReleaseService,
  { readonly release: (lockPath: string, owner: LockOwner) => Effect.Effect<void, FileLockError> }
>()("@rendotdev/rig/settings/FileLockReleaseService", {
  make: Effect.gen(function* () {
    const platform = yield* FileLockPlatformService;
    const hasCode = (error: unknown, code: string) => {
      const cause = Predicate.hasProperty(error, "cause") ? error.cause : error;
      return Predicate.hasProperty(cause, "code") && cause.code === code;
    };
    const mapReleaseError = (lockPath: string) => (cause: unknown) =>
      new FileLockError({ operation: "release", lockPath, cause });
    const release = Effect.fn("FileLockReleaseService.release")(function* (
      lockPath: string,
      owner: LockOwner,
    ) {
      const current = yield* platform.readText(join(lockPath, "owner.json")).pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => JSON.parse(content) as { token?: unknown },
            catch: mapReleaseError(lockPath),
          }),
        ),
        Effect.catch((error) =>
          hasCode(error, "ENOENT") ? Effect.void : Effect.fail(mapReleaseError(lockPath)(error)),
        ),
      );
      const ownerChanged = !current || current.token !== owner.token;
      if (ownerChanged) return;
      yield* platform.removeDirectory(lockPath).pipe(Effect.mapError(mapReleaseError(lockPath)));
    });
    return { release } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockReleaseService, FileLockReleaseService.make);
}

class FileLockRecoveryService extends Context.Service<
  FileLockRecoveryService,
  {
    readonly tryAcquire: (lockPath: string) => Effect.Effect<LockOwner | undefined, FileLockError>;
    readonly recover: (lockPath: string, staleMs: number) => Effect.Effect<boolean, FileLockError>;
    readonly release: (lockPath: string, owner: LockOwner) => Effect.Effect<void, FileLockError>;
  }
>()("@rendotdev/rig/settings/FileLockRecoveryService", {
  make: Effect.gen(function* () {
    const platform = yield* FileLockPlatformService;
    const runtime = yield* FileLockRuntimeService;
    const owners = yield* FileLockOwnerService;
    const liveness = yield* FileLockOwnerLivenessService;
    const releases = yield* FileLockReleaseService;
    const hasCode = (error: unknown, code: string) => {
      const cause = Predicate.hasProperty(error, "cause") ? error.cause : error;
      return Predicate.hasProperty(cause, "code") && cause.code === code;
    };
    const mapAcquireError = (lockPath: string) => (cause: unknown) =>
      new FileLockError({ operation: "acquire", lockPath, cause });
    const tryAcquire = Effect.fn("FileLockRecoveryService.tryAcquire")(function* (
      lockPath: string,
    ) {
      return yield* owners.tryAcquire(lockPath);
    });
    const recover = Effect.fn("FileLockRecoveryService.recover")(function* (
      lockPath: string,
      staleMs: number,
    ) {
      const modifiedAt = yield* platform
        .modifiedAt(lockPath)
        .pipe(
          Effect.catch((error) =>
            hasCode(error, "ENOENT") ? Effect.void : Effect.fail(mapAcquireError(lockPath)(error)),
          ),
        );
      const lockIsMissingOrFresh =
        modifiedAt === undefined || (yield* runtime.now) - modifiedAt <= staleMs;
      if (lockIsMissingOrFresh) return false;
      const owner = yield* owners.read(lockPath);
      const ownerIsAlive = owner && (yield* liveness.isAlive(owner));
      if (ownerIsAlive) return false;
      const stalePath = `${lockPath}.stale-${yield* runtime.randomUuid}`;
      const renamed = yield* platform.rename(lockPath, stalePath).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          hasCode(error, "ENOENT")
            ? Effect.succeed(false)
            : Effect.fail(mapAcquireError(lockPath)(error)),
        ),
      );
      if (!renamed) return false;
      yield* platform.removeDirectory(stalePath).pipe(Effect.mapError(mapAcquireError(lockPath)));
      return true;
    });
    const release = Effect.fn("FileLockRecoveryService.release")(function* (
      lockPath: string,
      owner: LockOwner,
    ) {
      yield* releases.release(lockPath, owner);
    });
    return { tryAcquire, recover, release } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockRecoveryService, FileLockRecoveryService.make);
}

class FileLockLeaseService extends Context.Service<
  FileLockLeaseService,
  {
    readonly acquire: (params: {
      lockPath: string;
      timeoutMs: number;
      staleMs: number;
      retryMs: number;
    }) => Effect.Effect<LockOwner, FileLockError>;
    readonly release: (lockPath: string, owner: LockOwner) => Effect.Effect<void, FileLockError>;
  }
>()("@rendotdev/rig/settings/FileLockLeaseService", {
  make: Effect.gen(function* () {
    const platform = yield* FileLockPlatformService;
    const runtime = yield* FileLockRuntimeService;
    const recovery = yield* FileLockRecoveryService;
    const timeoutError = (lockPath: string, timeoutMs: number) =>
      new FileLockError({
        operation: "acquire",
        lockPath,
        cause: new RigError({
          code: "CONFIG_INVALID",
          message: `Timed out waiting for lock: ${lockPath}`,
          details: { lockPath, timeoutMs },
        }),
      });
    const acquire = Effect.fn("FileLockLeaseService.acquire")(function* (params: {
      lockPath: string;
      timeoutMs: number;
      staleMs: number;
      retryMs: number;
    }) {
      yield* platform
        .makeDirectory(dirname(params.lockPath), true)
        .pipe(
          Effect.mapError(
            (cause) =>
              new FileLockError({ operation: "acquire", lockPath: params.lockPath, cause }),
          ),
        );
      const startedAt = yield* runtime.now;
      const attempt = Effect.gen(function* () {
        const owner = yield* recovery.tryAcquire(params.lockPath);
        if (owner) return owner;
        if (yield* recovery.recover(params.lockPath, params.staleMs)) {
          const recoveredOwner = yield* recovery.tryAcquire(params.lockPath);
          if (recoveredOwner) return recoveredOwner;
        }
        if ((yield* runtime.now) - startedAt >= params.timeoutMs) {
          return yield* timeoutError(params.lockPath, params.timeoutMs);
        }
        yield* runtime.sleep(params.retryMs);
        return yield* new FileLockContentionError({ lockPath: params.lockPath });
      });
      const retries = Math.max(1, Math.ceil(params.timeoutMs / Math.max(1, params.retryMs)) + 1);
      return yield* Effect.retry(attempt, {
        schedule: Schedule.recurs(retries),
        while: (error) => error instanceof FileLockContentionError,
      }).pipe(
        Effect.catch((error) =>
          error instanceof FileLockContentionError
            ? Effect.fail(timeoutError(params.lockPath, params.timeoutMs))
            : Effect.fail(error),
        ),
      );
    });
    const release = Effect.fn("FileLockLeaseService.release")(function* (
      lockPath: string,
      owner: LockOwner,
    ) {
      yield* recovery.release(lockPath, owner);
    });
    return { acquire, release } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockLeaseService, FileLockLeaseService.make);
}

export class FileLockService extends Context.Service<
  FileLockService,
  {
    readonly withLock: <Result, Error, Requirements>(params: {
      targetPath: string;
      options?: FileLockOptions;
      operation: () => Effect.Effect<Result, Error, Requirements>;
    }) => Effect.Effect<Result, Error | FileLockError, Requirements>;
  }
>()("@rendotdev/rig/settings/FileLockService", {
  make: Effect.gen(function* () {
    const defaults = yield* FileLockConfigService;
    const leases = yield* FileLockLeaseService;
    const withLock = Effect.fn("FileLockService.withLock")(function* <
      Result,
      Error,
      Requirements,
    >(params: {
      targetPath: string;
      options?: FileLockOptions;
      operation: () => Effect.Effect<Result, Error, Requirements>;
    }) {
      const lockPath = `${params.targetPath}.lock`;
      return yield* Effect.acquireUseRelease(
        leases.acquire({
          lockPath,
          timeoutMs: params.options?.timeoutMs ?? defaults.timeoutMs,
          staleMs: params.options?.staleMs ?? defaults.staleMs,
          retryMs: params.options?.retryMs ?? defaults.retryMs,
        }),
        params.operation,
        (owner) => leases.release(lockPath, owner),
      );
    });
    return { withLock } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockService, FileLockService.make);
}

const fileLockOwnerLayer = FileLockOwnerService.layer.pipe(
  Layer.provide(Layer.merge(FileLockPlatformService.layer, FileLockRuntimeService.layer)),
);
const fileLockOwnerLivenessLayer = FileLockOwnerLivenessService.layer.pipe(
  Layer.provide(FileLockRuntimeService.layer),
);
const fileLockReleaseLayer = FileLockReleaseService.layer.pipe(
  Layer.provide(FileLockPlatformService.layer),
);
const fileLockRecoveryLayer = FileLockRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      FileLockPlatformService.layer,
      FileLockRuntimeService.layer,
      fileLockOwnerLayer,
      fileLockOwnerLivenessLayer,
      fileLockReleaseLayer,
    ),
  ),
);
const fileLockLeaseLayer = FileLockLeaseService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      FileLockPlatformService.layer,
      FileLockRuntimeService.layer,
      fileLockRecoveryLayer,
    ),
  ),
);
export const fileLockLayer = FileLockService.layer.pipe(
  Layer.provide(Layer.merge(FileLockConfigService.layer, fileLockLeaseLayer)),
);
