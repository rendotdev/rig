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
import pino, { type Logger } from "pino";
import { defineRuntime, defineService, defineSingleton } from "../../define";
import { RigPathsClass, type PathOptions } from "../../config/paths";

export type RigLoggerOptions = PathOptions & {
  env?: NodeJS.ProcessEnv;
  level?: string;
  logDir?: string;
  maxFileSizeBytes?: number;
  retentionDays?: number;
  now?: () => number;
};

type ResolvedRigLoggerOptions = {
  enabled: boolean;
  level: string;
  logDir: string;
  maxFileSizeBytes: number;
  retentionDays: number;
  now: () => number;
};

const DefaultMaxFileSizeBytes = 5 * 1024 * 1024;
const DefaultRetentionDays = 7;
const MillisecondsPerDay = 24 * 60 * 60 * 1000;

function positiveNumber(params: {
  optionValue: number | undefined;
  envValue: string | undefined;
  fallback: number;
}): number {
  const value = params.optionValue ?? (params.envValue ? Number(params.envValue) : undefined);
  return value && Number.isFinite(value) && value > 0 ? value : params.fallback;
}

function resolveLoggerOptions(params: { options: RigLoggerOptions }): ResolvedRigLoggerOptions {
  const env = params.options.env ?? process.env;
  const paths = new RigPathsClass(params.options);
  return {
    enabled: env.RIG_LOG !== "0",
    level: params.options.level ?? env.RIG_LOG_LEVEL ?? "info",
    logDir: params.options.logDir ?? env.RIG_LOG_DIR ?? paths.logsDir,
    maxFileSizeBytes: positiveNumber({
      optionValue: params.options.maxFileSizeBytes,
      envValue: env.RIG_LOG_MAX_BYTES,
      fallback: DefaultMaxFileSizeBytes,
    }),
    retentionDays: positiveNumber({
      optionValue: params.options.retentionDays,
      envValue: env.RIG_LOG_RETENTION_DAYS,
      fallback: DefaultRetentionDays,
    }),
    now: params.options.now ?? Date.now,
  };
}

export const RigLoggerOptionResolverSingleton = defineSingleton({
  params: {},
  deps: {},
  resolve: resolveLoggerOptions,
});

export type LogRotationLockParams = {
  logDir: string;
  waitTimeoutMs?: number;
  staleAfterMs?: number;
};

export type LogRotationLockDeps = {
  now: () => number;
  wait: (buffer: Int32Array, index: number, value: number, timeout: number) => string;
  makeDirectory: (path: string) => void;
  readStatus: (path: string) => { mtimeMs: number };
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
};

const logRotationLockDeps: LogRotationLockDeps = {
  now: Date.now,
  wait(buffer, index, value, timeout) {
    return Atomics.wait(buffer, index, value, timeout);
  },
  makeDirectory(path) {
    mkdirSync(path);
  },
  readStatus(path) {
    return statSync(path);
  },
  rename(from, to) {
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
};

function errorCode(params: { error: unknown }): string | undefined {
  if (typeof params.error !== "object" || params.error === null || !("code" in params.error)) {
    return undefined;
  }
  return typeof params.error.code === "string" ? params.error.code : undefined;
}

export class LogRotationLockRuntime extends defineRuntime({
  params: { logDir: "" } as LogRotationLockParams,
  deps: logRotationLockDeps,
}) {
  private readonly lockPath = join(this.params.logDir, ".rig.log.rotation.lock");
  private readonly waitBuffer = new Int32Array(new SharedArrayBuffer(4));

  private tryAcquire(_params: {}): boolean {
    try {
      this.deps.makeDirectory(this.lockPath);
      return true;
    } catch (error) {
      if (errorCode({ error }) === "EEXIST") return false;
      throw error;
    }
  }

  private recoverStaleLock(_params: {}): void {
    try {
      if (
        this.deps.now() - this.deps.readStatus(this.lockPath).mtimeMs <=
        (this.params.staleAfterMs ?? 30_000)
      ) {
        return;
      }
      const stalePath = `${this.lockPath}.stale-${process.pid}-${this.deps.now()}`;
      this.deps.rename(this.lockPath, stalePath);
      this.deps.remove(stalePath);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes(errorCode({ error }) ?? "")) return;
      throw error;
    }
  }

  public run(params: { operation: () => void }): boolean {
    const startedAt = this.deps.now();
    while (!this.tryAcquire({})) {
      this.recoverStaleLock({});
      if (this.deps.now() - startedAt >= (this.params.waitTimeoutMs ?? 1_000)) return false;
      this.deps.wait(this.waitBuffer, 0, 0, 10);
    }

    try {
      params.operation();
      return true;
    } finally {
      this.deps.remove(this.lockPath);
    }
  }
}

export type LogRotationLockClass = { run(operation: () => void): boolean };

type LogRotationLockConstructor = {
  new (params: LogRotationLockParams, deps?: LogRotationLockDeps): LogRotationLockClass;
  readonly prototype: LogRotationLockClass;
};

type LogRotationLockAdapter = LogRotationLockClass & {
  readonly resource: LogRotationLockRuntime;
};

const LogRotationLockClassAdapter = function constructLogRotationLock(
  this: LogRotationLockAdapter,
  params: LogRotationLockParams,
  deps: LogRotationLockDeps = logRotationLockDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new LogRotationLockRuntime({ params, deps }),
  });
};
Object.defineProperty(LogRotationLockClassAdapter, "name", { value: "LogRotationLockClass" });
Object.defineProperty(LogRotationLockClassAdapter.prototype, "run", {
  configurable: true,
  value: function run(this: LogRotationLockAdapter, operation: () => void) {
    return this.resource.run({ operation });
  },
  writable: true,
});

export const LogRotationLockClass =
  LogRotationLockClassAdapter as unknown as LogRotationLockConstructor;

function logFileSize(params: { path: string }): number {
  try {
    return statSync(params.path).size;
  } catch {
    return 0;
  }
}

function createRollingLogDestination(options: ResolvedRigLoggerOptions): Writable {
  const activeFileName = "rig.log";
  const rotationLock = new LogRotationLockClass({ logDir: options.logDir });
  let activeSize = 0;

  function activePath(): string {
    return join(options.logDir, activeFileName);
  }

  function logEntries(): string[] {
    try {
      return readdirSync(options.logDir).filter(function isArchive(entry) {
        return entry.startsWith("rig-") && entry.endsWith(".log");
      });
    } catch {
      /* v8 ignore next */
      return [];
    }
  }

  function cleanupExpiredLogs(): void {
    const cutoff = options.now() - options.retentionDays * MillisecondsPerDay;
    for (const entry of logEntries()) {
      const path = join(options.logDir, entry);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* v8 ignore next */
        // Log cleanup should never prevent the requested Rig command from running.
      }
    }
  }

  function archivePath(): string {
    const timestamp = new Date(options.now()).toISOString().replace(/[:.]/g, "-");
    for (let index = 0; ; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = join(options.logDir, `rig-${timestamp}${suffix}.log`);
      if (!existsSync(candidate)) return candidate;
    }
  }

  function rotateIfNeeded(nextBytes: number): void {
    rotationLock.run(function rotate() {
      const lockedSize = logFileSize({ path: activePath() });
      if (lockedSize === 0 || lockedSize + nextBytes <= options.maxFileSizeBytes) {
        activeSize = lockedSize;
        return;
      }
      renameSync(activePath(), archivePath());
      activeSize = 0;
      cleanupExpiredLogs();
    });
  }

  function appendBuffers(buffers: Buffer[]): void {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    function flush() {
      if (pendingBytes === 0) return;
      appendFileSync(
        activePath(),
        pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes),
      );
      activeSize += pendingBytes;
      pending = [];
      pendingBytes = 0;
    }

    for (const buffer of buffers) {
      if (activeSize + pendingBytes + buffer.byteLength > options.maxFileSizeBytes) {
        flush();
        rotateIfNeeded(buffer.byteLength);
      }
      pending.push(buffer);
      pendingBytes += buffer.byteLength;
    }
    flush();
  }

  mkdirSync(options.logDir, { recursive: true });
  rotationLock.run(cleanupExpiredLogs);
  activeSize = logFileSize({ path: activePath() });

  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        appendBuffers([Buffer.from(chunk)]);
        queueMicrotask(callback);
      } catch (error) {
        /* v8 ignore next */
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    writev(chunks, callback) {
      try {
        appendBuffers(chunks.map((entry) => Buffer.from(entry.chunk)));
        queueMicrotask(callback);
      } catch (error) {
        /* v8 ignore next */
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

const destinations = new Map<string, Writable>();

export const RigLoggerDestinationRegistrySingleton = defineSingleton({
  params: {},
  deps: {},
  get(params: { options: ResolvedRigLoggerOptions }): Writable {
    const key = [
      params.options.logDir,
      params.options.maxFileSizeBytes,
      params.options.retentionDays,
    ].join("\0");
    const existing = destinations.get(key);
    if (existing) return existing;
    const destination = createRollingLogDestination(params.options);
    destinations.set(key, destination);
    return destination;
  },
});

type RigLoggerFactoryDeps = {
  pino: typeof pino;
  destination: typeof RigLoggerDestinationRegistrySingleton.get;
};

const RigLoggerFactoryProductionDeps: RigLoggerFactoryDeps = {
  pino,
  destination(params) {
    return RigLoggerDestinationRegistrySingleton.get(params);
  },
};

export class RigLoggerFactoryService extends defineService({
  params: {} as RigLoggerOptions,
  deps: RigLoggerFactoryProductionDeps,
}) {
  private readonly options = RigLoggerOptionResolverSingleton.resolve({ options: this.params });
  private logger: Logger | undefined;

  private base(_params: {}): Logger {
    if (this.logger) return this.logger;
    if (!this.options.enabled) {
      this.logger = this.deps.pino({ enabled: false });
      return this.logger;
    }
    this.logger = this.deps.pino(
      {
        name: "rig",
        level: this.options.level,
        base: { app: "rig", pid: process.pid },
        timestamp: this.deps.pino.stdTimeFunctions.isoTime,
        serializers: { err: this.deps.pino.stdSerializers.err },
      },
      this.deps.destination({ options: this.options }),
    );
    return this.logger;
  }

  public app(params: { component: string }): Logger {
    return this.base({}).child({
      prefix: `rig:${params.component}`,
      component: params.component,
    });
  }

  public tool(params: { tool: string; command: string }): Logger {
    return this.base({}).child({
      prefix: `tool:${params.tool}.${params.command}`,
      component: "tool",
      tool: params.tool,
      command: params.command,
    });
  }
}

export type RigLoggerFactoryClass = {
  app(component?: string): Logger;
  tool(tool: string, command: string): Logger;
};

type RigLoggerFactoryConstructor = {
  new (options?: RigLoggerOptions): RigLoggerFactoryClass;
  readonly prototype: RigLoggerFactoryClass;
};

type RigLoggerFactoryAdapter = RigLoggerFactoryClass & {
  readonly resource: RigLoggerFactoryService;
};

const RigLoggerFactoryClassAdapter = function constructRigLoggerFactory(
  this: RigLoggerFactoryAdapter,
  options: RigLoggerOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new RigLoggerFactoryService({
      params: options,
      deps: RigLoggerFactoryProductionDeps,
    }),
  });
};
Object.defineProperty(RigLoggerFactoryClassAdapter, "name", { value: "RigLoggerFactoryClass" });
Object.defineProperties(RigLoggerFactoryClassAdapter.prototype, {
  app: {
    configurable: true,
    value: function app(this: RigLoggerFactoryAdapter, component = "app") {
      return this.resource.app({ component });
    },
    writable: true,
  },
  tool: {
    configurable: true,
    value: function createToolLogger(
      this: RigLoggerFactoryAdapter,
      toolName: string,
      command: string,
    ) {
      return this.resource.tool({ tool: toolName, command });
    },
    writable: true,
  },
});

export const RigLoggerFactoryClass =
  RigLoggerFactoryClassAdapter as unknown as RigLoggerFactoryConstructor;
