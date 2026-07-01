import { Writable } from "node:stream";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { RigPaths, type PathOptions } from "../config/paths";

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

class RigLoggerOptionResolver {
  constructor(private readonly options: RigLoggerOptions) {}

  resolve(): ResolvedRigLoggerOptions {
    const env = this.options.env ?? process.env;
    const paths = new RigPaths(this.options);
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

class RollingLogFileDestination extends Writable {
  private readonly activeFileName = "rig.log";
  private activeSize = 0;

  constructor(private readonly options: ResolvedRigLoggerOptions) {
    super();
    mkdirSync(this.options.logDir, { recursive: true });
    this.cleanupExpiredLogs();
    this.activeSize = this.fileSize(this.activePath());
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const buffer = Buffer.from(chunk);
      this.rotateIfNeeded(buffer.byteLength);
      appendFileSync(this.activePath(), buffer);
      this.activeSize += buffer.byteLength;
      callback();
    } catch (error) {
      /* v8 ignore next */
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (this.activeSize === 0 || this.activeSize + nextBytes <= this.options.maxFileSizeBytes) {
      return;
    }

    /* v8 ignore else */
    if (existsSync(this.activePath())) renameSync(this.activePath(), this.archivePath());
    this.activeSize = 0;
    this.cleanupExpiredLogs();
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
      return readdirSync(this.options.logDir).filter((entry) => entry.endsWith(".log"));
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

class RigLoggerDestinationRegistry {
  private static readonly destinations = new Map<string, RollingLogFileDestination>();

  get(options: ResolvedRigLoggerOptions): RollingLogFileDestination {
    const key = [options.logDir, options.maxFileSizeBytes, options.retentionDays].join("\0");
    const existing = RigLoggerDestinationRegistry.destinations.get(key);
    if (existing) return existing;

    const destination = new RollingLogFileDestination(options);
    RigLoggerDestinationRegistry.destinations.set(key, destination);
    return destination;
  }
}

export class RigLoggerFactory {
  private readonly options: ResolvedRigLoggerOptions;
  private readonly destinations = new RigLoggerDestinationRegistry();
  private logger?: Logger;

  constructor(options: RigLoggerOptions = {}) {
    this.options = new RigLoggerOptionResolver(options).resolve();
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
