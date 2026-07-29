import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { Context, Effect, Layer, Schema } from "effect";
import { ManagedProcessService, managedProcessLayer } from "./managed-process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TRUNCATION_MARKER = "\n[rig: output truncated]";

export type ShellOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

type ShellResult = {
  readonly command: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type RigShellChildProcess = ChildProcess & {
  readonly stdout: Readable;
  readonly stderr: Readable;
};
export type RigShellProcessResult = ShellResult & {
  readonly exitCodeKnown: boolean;
  readonly signal?: NodeJS.Signals;
};

const RigShellOperation = Schema.Literals(["exec", "bash", "template", "json"]);
type RigShellOperation = typeof RigShellOperation.Type;

export class RigShellError extends Schema.TaggedErrorClass<RigShellError>()("RigShellError", {
  operation: RigShellOperation,
  command: Schema.Array(Schema.String),
  cause: Schema.Defect(),
}) {}

export class RigShellConfigService extends Context.Service<
  RigShellConfigService,
  {
    readonly defaults: ShellOptions;
  }
>()("@rendotdev/rig/runtime/RigShellConfigService", {
  make: Effect.succeed({ defaults: {} }),
}) {
  static readonly layer = Layer.effect(RigShellConfigService, RigShellConfigService.make);
}

export class RigShellPlatformService extends Context.Service<
  RigShellPlatformService,
  {
    readonly environment: Effect.Effect<NodeJS.ProcessEnv>;
    readonly currentDirectory: Effect.Effect<string>;
    readonly detached: Effect.Effect<boolean>;
    readonly spawn: (params: {
      readonly command: string;
      readonly arguments: string[];
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly detached: boolean;
    }) => Effect.Effect<RigShellChildProcess, unknown>;
  }
>()("@rendotdev/rig/runtime/RigShellPlatformService", {
  make: Effect.gen(function* () {
    const environment = Effect.sync(() => process.env).pipe(
      Effect.withSpan("RigShellPlatformService.environment"),
    );
    const currentDirectory = Effect.sync(() => process.cwd()).pipe(
      Effect.withSpan("RigShellPlatformService.currentDirectory"),
    );
    const detached = Effect.sync(() => process.platform !== "win32").pipe(
      Effect.withSpan("RigShellPlatformService.detached"),
    );
    const spawn = Effect.fn("RigShellPlatformService.spawn")(function* (params: {
      readonly command: string;
      readonly arguments: string[];
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly detached: boolean;
    }) {
      return yield* Effect.try(() =>
        nodeSpawn(params.command, params.arguments, {
          cwd: params.cwd,
          env: params.environment,
          stdio: ["ignore", "pipe", "pipe"],
          detached: params.detached,
        }),
      );
    });
    return { environment, currentDirectory, detached, spawn } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigShellPlatformService, RigShellPlatformService.make);
}

export class ShellTemplateService extends Context.Service<
  ShellTemplateService,
  {
    readonly render: (strings: TemplateStringsArray, values: unknown[]) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/runtime/ShellTemplateService", {
  make: Effect.gen(function* () {
    const quote = (value: string): string => {
      if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
      return `'${value.replaceAll("'", "'\\''")}'`;
    };
    const renderValue = (value: unknown): string =>
      Array.isArray(value)
        ? value.map((item) => quote(String(item))).join(" ")
        : quote(String(value));
    const render = Effect.fn("ShellTemplateService.render")(function* (
      strings: TemplateStringsArray,
      values: unknown[],
    ) {
      return strings.reduce((command, part, index) => {
        const value = index < values.length ? renderValue(values[index]) : "";
        return `${command}${part}${value}`;
      }, "");
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ShellTemplateService, ShellTemplateService.make);
}

export class ShellOutputService extends Context.Service<
  ShellOutputService,
  {
    readonly observe: (
      stream: Readable,
      maxBytes: number,
    ) => Effect.Effect<{ readonly complete: Effect.Effect<string> }>;
  }
>()("@rendotdev/rig/runtime/ShellOutputService", {
  make: Effect.gen(function* () {
    const decode = (buffer: Buffer): string => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (let removed = 0; removed <= Math.min(3, buffer.byteLength); removed += 1) {
        try {
          return decoder.decode(buffer.subarray(0, buffer.byteLength - removed));
        } catch {
          continue;
        }
      }
      return new TextDecoder().decode(buffer);
    };
    const observe = Effect.fn("ShellOutputService.observe")(function* (
      stream: Readable,
      maxBytes: number,
    ) {
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      let truncated = false;
      const capture = (buffer: Buffer) => {
        const remaining = Math.max(0, maxBytes - capturedBytes);
        if (remaining > 0) {
          const captured = buffer.subarray(0, remaining);
          chunks.push(captured);
          capturedBytes += captured.byteLength;
        }
        if (buffer.byteLength > remaining) truncated = true;
      };
      yield* Effect.sync(() => stream.on("data", capture));
      const complete = Effect.sync(() => {
        const content = decode(Buffer.concat(chunks, capturedBytes));
        return truncated ? `${content}${TRUNCATION_MARKER}` : content;
      }).pipe(Effect.withSpan("ShellOutputService.complete"));
      return { complete } as const;
    });
    return { observe } as const;
  }),
}) {
  static readonly layer = Layer.effect(ShellOutputService, ShellOutputService.make);
}

export class ShellProcessService extends Context.Service<
  ShellProcessService,
  {
    readonly run: (params: {
      readonly args: string[];
      readonly options?: ShellOptions;
      readonly reportedCommand?: string[];
    }) => Effect.Effect<RigShellProcessResult, RigShellError>;
  }
>()("@rendotdev/rig/runtime/ShellProcessService", {
  make: Effect.gen(function* () {
    const config = yield* RigShellConfigService;
    const platform = yield* RigShellPlatformService;
    const managedProcess = yield* ManagedProcessService;
    const output = yield* ShellOutputService;
    const run = Effect.fn("ShellProcessService.run")(function* (params: {
      readonly args: string[];
      readonly options?: ShellOptions;
      readonly reportedCommand?: string[];
    }) {
      const options = params.options ?? {};
      const reportedCommand = params.reportedCommand ?? params.args;
      const timeoutMs = options.timeoutMs ?? config.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBytes =
        options.maxOutputBytes ?? config.defaults.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const child = yield* platform
        .spawn({
          command: params.args[0]!,
          arguments: params.args.slice(1),
          cwd: options.cwd ?? config.defaults.cwd ?? (yield* platform.currentDirectory),
          environment: {
            ...(yield* platform.environment),
            ...config.defaults.env,
            ...options.env,
          },
          detached: yield* platform.detached,
        })
        .pipe(
          Effect.mapError(
            (cause) => new RigShellError({ operation: "exec", command: reportedCommand, cause }),
          ),
        );
      const stdout = yield* output.observe(child.stdout, maxBytes);
      const stderr = yield* output.observe(child.stderr, maxBytes);
      const processResult = yield* managedProcess
        .wait({ child, command: reportedCommand, timeoutMs })
        .pipe(
          Effect.mapError(
            (cause) => new RigShellError({ operation: "exec", command: reportedCommand, cause }),
          ),
        );
      return {
        command: reportedCommand,
        stdout: yield* stdout.complete,
        stderr: yield* stderr.complete,
        exitCode: processResult.exitCode,
        exitCodeKnown: processResult.exitCodeKnown,
        ...(processResult.signal ? { signal: processResult.signal } : {}),
      };
    });
    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(ShellProcessService, ShellProcessService.make);
}

export class RigShellService extends Context.Service<
  RigShellService,
  {
    readonly exec: (
      args: string[],
      options?: ShellOptions,
    ) => Effect.Effect<RigShellProcessResult, RigShellError>;
    readonly bash: (
      command: string,
      options?: ShellOptions,
    ) => Effect.Effect<RigShellProcessResult, RigShellError>;
    readonly template: (
      strings: TemplateStringsArray,
      values: unknown[],
    ) => Effect.Effect<RigShellProcessResult, RigShellError>;
    readonly json: (
      args: string[],
      options?: ShellOptions,
    ) => Effect.Effect<unknown, RigShellError>;
  }
>()("@rendotdev/rig/runtime/RigShellService", {
  make: Effect.gen(function* () {
    const processService = yield* ShellProcessService;
    const templateService = yield* ShellTemplateService;
    const validate = (args: string[]): RigShellError | undefined =>
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some((argument) => typeof argument !== "string" || argument.length === 0)
        ? new RigShellError({
            operation: "exec",
            command: args,
            cause: "shell.exec expects a non-empty array of command arguments.",
          })
        : undefined;
    const exec = Effect.fn("RigShellService.exec")(function* (
      args: string[],
      options?: ShellOptions,
    ) {
      const error = validate(args);
      if (error) return yield* error;
      return yield* processService.run({ args, options });
    });
    const bash = Effect.fn("RigShellService.bash")(function* (
      command: string,
      options?: ShellOptions,
    ) {
      return yield* processService.run({
        args: ["bash", "-lc", command],
        options,
        reportedCommand: [command],
      });
    });
    const template = Effect.fn("RigShellService.template")(function* (
      strings: TemplateStringsArray,
      values: unknown[],
    ) {
      const command = yield* templateService.render(strings, values);
      return yield* bash(command).pipe(
        Effect.mapError(
          (error) => new RigShellError({ operation: "template", command: [command], cause: error }),
        ),
      );
    });
    const json = Effect.fn("RigShellService.json")(function* (
      args: string[],
      options?: ShellOptions,
    ) {
      const result = yield* exec(args, options);
      if (result.exitCode !== 0) {
        return yield* new RigShellError({ operation: "json", command: args, cause: result });
      }
      return yield* Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: (cause) => new RigShellError({ operation: "json", command: args, cause }),
      });
    });
    return { exec, bash, template, json } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigShellService, RigShellService.make);
}

const shellProcessLayer = ShellProcessService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      RigShellConfigService.layer,
      RigShellPlatformService.layer,
      managedProcessLayer,
      ShellOutputService.layer,
    ),
  ),
);

export const rigShellLayer = RigShellService.layer.pipe(
  Layer.provide(Layer.merge(ShellTemplateService.layer, shellProcessLayer)),
);
