import { Writable } from "node:stream";
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
import pino, { type Logger } from "pino";
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

class RigLoggerOptionResolverClass {
  constructor(private readonly options: RigLoggerOptions) {}

  resolve(): ResolvedRigLoggerOptions {
    const env = this.options.env ?? process.env;
    const paths = new RigPathsClass(this.options);
    return {
      enabled: env.RIG_LOG !== "0",
      level: this.options.level ?? env.RIG_LOG_LEVEL ?? "info",
      logDir: this.options.logDir ?? env.RIG_LOG_DIR ?? paths.logsDir,
      maxFileSizeBytes: this.positiveNumber(
        this.options.maxFileSizeBytes,
        env.RIG_LOG_MAX_BYTES,
        DefaultMaxFileSizeBytes,
      ),
      retentionDays: this.positiveNumber(
        this.options.retentionDays,
        env.RIG_LOG_RETENTION_DAYS,
        DefaultRetentionDays,
      ),
      now: this.options.now ?? Date.now,
    };
  }

  private positiveNumber(
    optionValue: number | undefined,
    envValue: string | undefined,
    fallback: number,
  ): number {
    const value = optionValue ?? (envValue ? Number(envValue) : undefined);
    return value && Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

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
  wait: (buffer, index, value, timeout) => Atomics.wait(buffer, index, value, timeout),
  makeDirectory: (path) => mkdirSync(path),
  readStatus: (path) => statSync(path),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

export class LogRotationLockClass {
  private readonly lockPath: string;
  private readonly waitBuffer = new Int32Array(new SharedArrayBuffer(4));

  constructor(
    private readonly params: LogRotationLockParams,
    private readonly deps: LogRotationLockDeps = logRotationLockDeps,
  ) {
    this.lockPath = join(this.params.logDir, ".rig.log.rotation.lock");
  }

  run(operation: () => void): boolean {
    const startedAt = this.deps.now();
    while (!this.tryAcquire()) {
      this.recoverStaleLock();
      if (this.deps.now() - startedAt >= (this.params.waitTimeoutMs ?? 1_000)) return false;
      this.deps.wait(this.waitBuffer, 0, 0, 10);
    }

    try {
      operation();
      return true;
    } finally {
      this.deps.remove(this.lockPath);
    }
  }

  private tryAcquire(): boolean {
    try {
      this.deps.makeDirectory(this.lockPath);
      return true;
    } catch (error) {
      if (this.errorCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  private recoverStaleLock(): void {
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
      if (["ENOENT", "EEXIST"].includes(this.errorCode(error) ?? "")) return;
      throw error;
    }
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
  }
}

class RollingLogFileDestinationClass extends Writable {
  private readonly activeFileName = "rig.log";
  private activeSize = 0;
  private readonly rotationLock: LogRotationLockClass;

  constructor(private readonly options: ResolvedRigLoggerOptions) {
    super();
    mkdirSync(this.options.logDir, { recursive: true });
    this.rotationLock = new LogRotationLockClass({ logDir: this.options.logDir });
    this.rotationLock.run(() => this.cleanupExpiredLogs());
    this.activeSize = this.fileSize(this.activePath());
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.appendBuffers([Buffer.from(chunk)]);
      queueMicrotask(callback);
    } catch (error) {
      /* v8 ignore next */
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _writev(
    chunks: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.appendBuffers(chunks.map((entry) => Buffer.from(entry.chunk)));
      queueMicrotask(callback);
    } catch (error) {
      /* v8 ignore next */
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private appendBuffers(buffers: Buffer[]): void {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pendingBytes === 0) return;
      appendFileSync(
        this.activePath(),
        pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes),
      );
      this.activeSize += pendingBytes;
      pending = [];
      pendingBytes = 0;
    };

    for (const buffer of buffers) {
      if (this.activeSize + pendingBytes + buffer.byteLength > this.options.maxFileSizeBytes) {
        flush();
        this.rotateIfNeeded(buffer.byteLength);
      }
      pending.push(buffer);
      pendingBytes += buffer.byteLength;
    }
    flush();
  }

  private rotateIfNeeded(nextBytes: number): void {
    this.rotationLock.run(() => {
      const lockedSize = this.fileSize(this.activePath());
      if (lockedSize === 0 || lockedSize + nextBytes <= this.options.maxFileSizeBytes) {
        this.activeSize = lockedSize;
        return;
      }
      renameSync(this.activePath(), this.archivePath());
      this.activeSize = 0;
      this.cleanupExpiredLogs();
    });
  }

  private cleanupExpiredLogs(): void {
    const cutoff = this.options.now() - this.options.retentionDays * MillisecondsPerDay;
    for (const entry of this.logEntries()) {
      const path = join(this.options.logDir, entry);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* v8 ignore next */
        // Log cleanup should never prevent the requested Rig command from running.
      }
    }
  }

  private logEntries(): string[] {
    try {
      return readdirSync(this.options.logDir).filter(
        (entry) => entry.startsWith("rig-") && entry.endsWith(".log"),
      );
    } catch {
      /* v8 ignore next */
      return [];
    }
  }

  private archivePath(): string {
    const timestamp = new Date(this.options.now()).toISOString().replace(/[:.]/g, "-");
    for (let index = 0; ; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = join(this.options.logDir, `rig-${timestamp}${suffix}.log`);
      if (!existsSync(candidate)) return candidate;
    }
  }

  private activePath(): string {
    return join(this.options.logDir, this.activeFileName);
  }

  private fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }
}

class RigLoggerDestinationRegistryClass {
  private readonly destinations = new Map<string, RollingLogFileDestinationClass>();

  get(options: ResolvedRigLoggerOptions): RollingLogFileDestinationClass {
    const key = [options.logDir, options.maxFileSizeBytes, options.retentionDays].join("\0");
    const existing = this.destinations.get(key);
    if (existing) return existing;

    const destination = new RollingLogFileDestinationClass(options);
    this.destinations.set(key, destination);
    return destination;
  }
}

const rigLoggerDestinationRegistry = new RigLoggerDestinationRegistryClass();

export class RigLoggerFactoryClass {
  private readonly options: ResolvedRigLoggerOptions;
  private readonly destinations = rigLoggerDestinationRegistry;
  private logger?: Logger;

  constructor(options: RigLoggerOptions = {}) {
    this.options = new RigLoggerOptionResolverClass(options).resolve();
  }

  app(component = "app"): Logger {
    return this.base().child({ prefix: `rig:${component}`, component });
  }

  tool(tool: string, command: string): Logger {
    return this.base().child({
      prefix: `tool:${tool}.${command}`,
      component: "tool",
      tool,
      command,
    });
  }

  private base(): Logger {
    if (this.logger) return this.logger;

    if (!this.options.enabled) {
      this.logger = pino({ enabled: false });
      return this.logger;
    }

    this.logger = pino(
      {
        name: "rig",
        level: this.options.level,
        base: { app: "rig", pid: process.pid },
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: { err: pino.stdSerializers.err },
      },
      this.destinations.get(this.options),
    );
    return this.logger;
  }
}
