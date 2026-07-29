import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Context, Effect, Layer, Scope } from "effect";
import pino, { type Logger } from "pino";
import { RigError } from "../errors/rig-error";
import { RigPathsConfigService, rigPathsConfigLayer } from "../paths/rig-paths";

const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type ResolvedRigLoggerConfig = Readonly<{
  enabled: boolean;
  level: string;
  logDir: string;
  maxFileSizeBytes: number;
  retentionDays: number;
  nowEpochMs: number;
}>;

export type LogRotationLock = Readonly<{ run: (operation: () => void) => boolean }>;
export type RigLogFile = Readonly<{ append: (buffers: Buffer[]) => void }>;

export class RigLoggerConfigService extends Context.Service<
  RigLoggerConfigService,
  {
    readonly enabled: boolean;
    readonly level: string;
    readonly logDir: string;
    readonly maxFileSizeBytes: number;
    readonly retentionDays: number;
    readonly nowEpochMs: number;
  }
>()("@rendotdev/rig/runtime/RigLoggerConfigService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const positiveNumber = (value: string | undefined, fallback: number): number => {
      const parsed = value ? Number(value) : undefined;
      return parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const enabled = process.env.RIG_LOG !== "0";
    const level = process.env.RIG_LOG_LEVEL ?? "info";
    const logDir = process.env.RIG_LOG_DIR ?? paths.logsDir;
    const maxFileSizeBytes = positiveNumber(
      process.env.RIG_LOG_MAX_BYTES,
      DEFAULT_MAX_FILE_SIZE_BYTES,
    );
    const retentionDays = positiveNumber(
      process.env.RIG_LOG_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    );
    const nowEpochMs = Date.now();
    return {
      enabled,
      level,
      logDir,
      maxFileSizeBytes,
      retentionDays,
      nowEpochMs,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigLoggerConfigService, RigLoggerConfigService.make);
}

export class LogRotationLockService extends Context.Service<
  LogRotationLockService,
  {
    readonly create: (params: {
      readonly logDir: string;
      readonly nowEpochMs: number;
      readonly waitTimeoutMs?: number;
      readonly staleAfterMs?: number;
    }) => Effect.Effect<LogRotationLock>;
  }
>()("@rendotdev/rig/runtime/LogRotationLockService", {
  make: Effect.gen(function* () {
    const create = Effect.fn("LogRotationLockService.create")(function* (params: {
      readonly logDir: string;
      readonly nowEpochMs: number;
      readonly waitTimeoutMs?: number;
      readonly staleAfterMs?: number;
    }) {
      const lockPath = join(params.logDir, ".rig.log.rotation.lock");
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      const errorCode = (error: unknown): string | undefined =>
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined;
      const tryAcquire = (): boolean => {
        try {
          mkdirSync(lockPath);
          return true;
        } catch (error) {
          if (errorCode(error) === "EEXIST") return false;
          throw error;
        }
      };
      const recoverStaleLock = () => {
        try {
          if (params.nowEpochMs - statSync(lockPath).mtimeMs <= (params.staleAfterMs ?? 30_000)) {
            return;
          }
          const stalePath = `${lockPath}.stale-${process.pid}-${params.nowEpochMs}`;
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        } catch (error) {
          if (["ENOENT", "EEXIST"].includes(errorCode(error) ?? "")) return;
          throw error;
        }
      };
      const run = (operation: () => void): boolean => {
        const startedAt = Date.now();
        while (!tryAcquire()) {
          recoverStaleLock();
          if (Date.now() - startedAt >= (params.waitTimeoutMs ?? 1_000)) return false;
          Atomics.wait(waitBuffer, 0, 0, 10);
        }
        try {
          operation();
          return true;
        } finally {
          rmSync(lockPath, { recursive: true, force: true });
        }
      };
      return { run } as const;
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(LogRotationLockService, LogRotationLockService.make);
}

export class RigLogFileService extends Context.Service<
  RigLogFileService,
  {
    readonly create: (config: ResolvedRigLoggerConfig) => Effect.Effect<RigLogFile, RigError>;
  }
>()("@rendotdev/rig/runtime/RigLogFileService", {
  make: Effect.gen(function* () {
    const locks = yield* LogRotationLockService;
    const create = Effect.fn("RigLogFileService.create")(function* (
      config: ResolvedRigLoggerConfig,
    ) {
      const lock = yield* locks.create({
        logDir: config.logDir,
        nowEpochMs: config.nowEpochMs,
      });
      return yield* Effect.try({
        try: () => {
          const activePath = join(config.logDir, "rig.log");
          const size = () => {
            try {
              return statSync(activePath).size;
            } catch {
              return 0;
            }
          };
          const cleanup = () => {
            const cutoff = config.nowEpochMs - config.retentionDays * MILLISECONDS_PER_DAY;
            for (const entry of readdirSync(config.logDir)) {
              const path = join(config.logDir, entry);
              try {
                const isExpiredArchive =
                  /^rig-.*\.log$/u.test(entry) && statSync(path).mtimeMs < cutoff;
                if (isExpiredArchive) unlinkSync(path);
              } catch {
                continue;
              }
            }
          };
          const archivePath = () => {
            const timestamp = new Date(config.nowEpochMs).toISOString().replace(/[:.]/gu, "-");
            for (let index = 0; ; index += 1) {
              const suffix = index === 0 ? "" : `-${index}`;
              const candidate = join(config.logDir, `rig-${timestamp}${suffix}.log`);
              if (!existsSync(candidate)) return candidate;
            }
          };
          mkdirSync(config.logDir, { recursive: true });
          lock.run(cleanup);
          let activeSize = size();
          const rotate = (nextBytes: number) => {
            lock.run(() => {
              const lockedSize = size();
              const hasRoomInActiveLog =
                lockedSize === 0 || lockedSize + nextBytes <= config.maxFileSizeBytes;
              if (hasRoomInActiveLog) {
                activeSize = lockedSize;
                return;
              }
              renameSync(activePath, archivePath());
              activeSize = 0;
              cleanup();
            });
          };
          const append = (buffers: Buffer[]) => {
            for (const buffer of buffers) {
              if (activeSize + buffer.byteLength > config.maxFileSizeBytes) {
                rotate(buffer.byteLength);
              }
              appendFileSync(activePath, buffer);
              activeSize += buffer.byteLength;
            }
          };
          return { append } as const;
        },
        catch: (cause) =>
          new RigError({ code: "INTERNAL_ERROR", message: String(cause), details: cause }),
      });
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigLogFileService, RigLogFileService.make);
}

export class RigLogDestinationService extends Context.Service<
  RigLogDestinationService,
  {
    readonly create: (config: ResolvedRigLoggerConfig) => Effect.Effect<Writable, RigError>;
  }
>()("@rendotdev/rig/runtime/RigLogDestinationService", {
  make: Effect.gen(function* () {
    const files = yield* RigLogFileService;
    const create = Effect.fn("RigLogDestinationService.create")(function* (
      config: ResolvedRigLoggerConfig,
    ) {
      const file = yield* files.create(config);
      return new Writable({
        write: (chunk, _encoding, callback) => {
          try {
            file.append([Buffer.from(chunk)]);
            queueMicrotask(callback);
          } catch (cause) {
            callback(cause instanceof Error ? cause : new Error(String(cause)));
          }
        },
        writev: (chunks, callback) => {
          try {
            file.append(chunks.map((entry) => Buffer.from(entry.chunk)));
            queueMicrotask(callback);
          } catch (cause) {
            callback(cause instanceof Error ? cause : new Error(String(cause)));
          }
        },
      });
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigLogDestinationService, RigLogDestinationService.make);
}

export class RigLoggerService extends Context.Service<
  RigLoggerService,
  {
    readonly app: (component?: string) => Effect.Effect<Logger, RigError>;
    readonly tool: (tool: string, command: string) => Effect.Effect<Logger, RigError>;
  }
>()("@rendotdev/rig/runtime/RigLoggerService", {
  make: Effect.gen(function* () {
    const config = yield* RigLoggerConfigService;
    const destinations = yield* RigLogDestinationService;
    const scope = yield* Scope.Scope;
    const resource = yield* Effect.cached(
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (!config.enabled) return { logger: pino({ enabled: false }) } as const;
          const destination = yield* destinations.create(config);
          const logger = pino(
            {
              name: "rig",
              level: config.level,
              base: { app: "rig", pid: process.pid },
              timestamp: pino.stdTimeFunctions.isoTime,
              serializers: { err: pino.stdSerializers.err },
            },
            destination,
          );
          return { logger, destination } as const;
        }),
        (value) =>
          Effect.sync(() => {
            value.logger.flush();
            if ("destination" in value) value.destination?.end();
          }),
      ).pipe(Scope.provide(scope)),
    );
    const app = Effect.fn("RigLoggerService.app")(function* (component = "app") {
      const acquired = yield* resource;
      return acquired.logger.child({ prefix: `rig:${component}`, component });
    });
    const tool = Effect.fn("RigLoggerService.tool")(function* (toolName: string, command: string) {
      const acquired = yield* resource;
      return acquired.logger.child({
        prefix: `tool:${toolName}.${command}`,
        component: "tool",
        tool: toolName,
        command,
      });
    });
    return { app, tool } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigLoggerService, RigLoggerService.make);
}

export const rigLoggerConfigLayer = RigLoggerConfigService.layer.pipe(
  Layer.provide(rigPathsConfigLayer),
);

export const rigLogFileLayer = RigLogFileService.layer.pipe(
  Layer.provide(LogRotationLockService.layer),
);

export const rigLogDestinationLayer = RigLogDestinationService.layer.pipe(
  Layer.provide(rigLogFileLayer),
);

export const rigLoggerLayer = RigLoggerService.layer.pipe(
  Layer.provide(Layer.merge(rigLoggerConfigLayer, rigLogDestinationLayer)),
);
