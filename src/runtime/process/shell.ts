import { spawn, type ChildProcess } from "node:child_process";
import { defineProvider, defineService, defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import type { RigShell, ShellOptions, ShellResult } from "../../tools/types";

const DefaultTimeoutMs = 30_000;
const DefaultMaxOutputBytes = 1_048_576;
const TerminationGraceMs = 100;
const TruncationMarker = "\n[rig: output truncated]";

function decodeUtf8Prefix(params: { buffer: Buffer }): string {
  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  for (let removed = 0; removed <= Math.min(3, params.buffer.byteLength); removed++) {
    try {
      return strictDecoder.decode(params.buffer.subarray(0, params.buffer.byteLength - removed));
    } catch {
      // A UTF-8 code point may be split at the byte boundary. Try the preceding boundary.
    }
  }
  return new TextDecoder().decode(params.buffer);
}

export const BoundedOutputCollectorSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { maxBytes: number }) {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;

    function capture(captureParams: { buffer: Buffer }): void {
      const remaining = Math.max(0, params.maxBytes - capturedBytes);
      if (remaining > 0) {
        const captured = captureParams.buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (captureParams.buffer.byteLength > remaining) truncated = true;
    }

    function result(_params: {}): string {
      const content = decodeUtf8Prefix({
        buffer: Buffer.concat(chunks, capturedBytes),
      });
      return truncated ? `${content}${TruncationMarker}` : content;
    }

    return { capture, result };
  },
});

type ManagedProcessFactoryDeps = {
  processGroup: boolean;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer: (timer: NodeJS.Timeout) => void;
};

const ManagedProcessFactoryProductionDeps: ManagedProcessFactoryDeps = {
  processGroup: process.platform !== "win32",
  killProcessGroup(pid, signal) {
    process.kill(-pid, signal);
  },
  setTimer(callback, delay) {
    return setTimeout(callback, delay);
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
};

export class ManagedProcessFactoryService extends defineService({
  params: {},
  deps: ManagedProcessFactoryProductionDeps,
}) {
  public create(params: { child: ChildProcess; command: string[]; timeoutMs: number }) {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;

    const signal = (signalParams: { signal: NodeJS.Signals }): void => {
      try {
        /* v8 ignore else -- Windows does not expose POSIX process groups */
        if (this.deps.processGroup && params.child.pid) {
          this.deps.killProcessGroup(params.child.pid, signalParams.signal);
        } else {
          params.child.kill(signalParams.signal);
        }
      } catch {
        /* v8 ignore next -- the process may exit between close detection and signaling */
        return;
      }
    };

    const terminate = (_params: {}): void => {
      timedOut = true;
      signal({ signal: "SIGTERM" });
      /* v8 ignore next -- process exit timing before forced escalation differs by platform */
      escalation = this.deps.setTimer(function forceTermination() {
        signal({ signal: "SIGKILL" });
      }, TerminationGraceMs);
    };

    const wait = async (_params: {}): Promise<number> => {
      params.child.once("error", function captureSpawnError(error) {
        spawnError = error;
      });
      timeout = this.deps.setTimer(function terminateOnTimeout() {
        terminate({});
      }, params.timeoutMs);

      try {
        const exitCode = await new Promise<number>(function waitForClose(resolveClose) {
          params.child.once("close", function handleClose(code) {
            resolveClose(code ?? 1);
          });
        });
        if (spawnError) {
          throw new RigErrorClass("SHELL_ERROR", `Command could not start: ${params.command[0]}`, {
            command: params.command,
            message: spawnError.message,
          });
        }
        if (timedOut) {
          throw new RigErrorClass("SHELL_ERROR", `Command timed out after ${params.timeoutMs}ms.`, {
            command: params.command,
          });
        }
        return exitCode;
      } finally {
        /* v8 ignore else -- every managed process installs a timeout */
        if (timeout) this.deps.clearTimer(timeout);
        if (escalation) this.deps.clearTimer(escalation);
      }
    };

    return { wait };
  }
}

export const ManagedProcessFactory = new ManagedProcessFactoryService();

function shellQuote(params: { value: string }): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(params.value)) return params.value;
  return `'${params.value.replaceAll("'", "'\\''")}'`;
}

function renderTemplateValue(params: { value: unknown }): string {
  if (Array.isArray(params.value)) {
    return params.value
      .map(function quoteItem(item) {
        return shellQuote({ value: String(item) });
      })
      .join(" ");
  }
  return shellQuote({ value: String(params.value) });
}

function renderTemplateCommand(params: {
  strings: TemplateStringsArray;
  values: unknown[];
}): string {
  return params.strings.reduce(function appendTemplatePart(command, part, index) {
    const value =
      index < params.values.length ? renderTemplateValue({ value: params.values[index] }) : "";
    return `${command}${part}${value}`;
  }, "");
}

function validateArgs(params: { args: string[] }): void {
  if (
    !Array.isArray(params.args) ||
    params.args.length === 0 ||
    params.args.some(function invalidArgument(argument) {
      return typeof argument !== "string" || argument.length === 0;
    })
  ) {
    throw new RigErrorClass(
      "SHELL_ERROR",
      "shell.exec expects a non-empty array of command arguments.",
      { args: params.args },
    );
  }
}

type BunRigShellDeps = {
  spawn: typeof spawn;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  detached: boolean;
  createCollector: typeof BoundedOutputCollectorSingleton.create;
  createManagedProcess: (params: { child: ChildProcess; command: string[]; timeoutMs: number }) => {
    wait(params: {}): Promise<number>;
  };
};

const BunRigShellProductionDeps: BunRigShellDeps = {
  spawn,
  env: process.env,
  cwd: process.cwd.bind(process),
  detached: process.platform !== "win32",
  createCollector(params) {
    return BoundedOutputCollectorSingleton.create(params);
  },
  createManagedProcess(params) {
    return ManagedProcessFactory.create(params);
  },
};

export class BunRigShellProvider extends defineProvider({
  params: {} as ShellOptions,
  deps: BunRigShellProductionDeps,
}) {
  private async runProcess(params: {
    args: string[];
    options?: ShellOptions;
    reportedCommand?: string[];
  }): Promise<ShellResult> {
    const options = params.options ?? {};
    const reportedCommand = params.reportedCommand ?? params.args;
    const timeoutMs = options.timeoutMs ?? this.params.timeoutMs ?? DefaultTimeoutMs;
    const maxOutputBytes =
      options.maxOutputBytes ?? this.params.maxOutputBytes ?? DefaultMaxOutputBytes;
    const child = this.deps.spawn(params.args[0]!, params.args.slice(1), {
      cwd: options.cwd ?? this.params.cwd ?? this.deps.cwd(),
      env: { ...this.deps.env, ...this.params.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.deps.detached,
    });
    const stdout = this.deps.createCollector({ maxBytes: maxOutputBytes });
    const stderr = this.deps.createCollector({ maxBytes: maxOutputBytes });
    child.stdout.on("data", function captureStdout(chunk: Buffer) {
      stdout.capture({ buffer: chunk });
    });
    child.stderr.on("data", function captureStderr(chunk: Buffer) {
      stderr.capture({ buffer: chunk });
    });
    const managed = this.deps.createManagedProcess({
      child,
      command: reportedCommand,
      timeoutMs,
    });
    const exitCode = await managed.wait({});

    return {
      command: reportedCommand,
      stdout: stdout.result({}),
      stderr: stderr.result({}),
      exitCode,
    };
  }

  public async exec(params: { args: string[]; options?: ShellOptions }): Promise<ShellResult> {
    validateArgs({ args: params.args });
    return await this.runProcess(params);
  }

  public async bash(params: { command: string; options?: ShellOptions }): Promise<ShellResult> {
    return await this.runProcess({
      args: ["bash", "-lc", params.command],
      options: params.options,
      reportedCommand: [params.command],
    });
  }

  public async template(params: {
    strings: TemplateStringsArray;
    values: unknown[];
  }): Promise<ShellResult> {
    return await this.bash({ command: renderTemplateCommand(params) });
  }

  public async json(params: { args: string[]; options?: ShellOptions }): Promise<unknown> {
    const result = await this.exec(params);
    if (result.exitCode !== 0) {
      throw new RigErrorClass("SHELL_ERROR", "Command failed before JSON could be parsed.", result);
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new RigErrorClass("SHELL_ERROR", "Command stdout was not valid JSON.", {
        result,
        error,
      });
    }
  }
}

export type BunRigShellClass = RigShell;

type BunRigShellConstructor = {
  new (defaults?: ShellOptions): BunRigShellClass;
  readonly prototype: BunRigShellClass;
};

type BunRigShellAdapter = BunRigShellClass & { readonly resource: BunRigShellProvider };

const BunRigShellClassAdapter = function constructBunRigShell(
  this: BunRigShellAdapter,
  defaults: ShellOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new BunRigShellProvider({ params: defaults, deps: BunRigShellProductionDeps }),
  });
};
Object.defineProperty(BunRigShellClassAdapter, "name", { value: "BunRigShellClass" });
Object.defineProperties(BunRigShellClassAdapter.prototype, {
  $: {
    configurable: true,
    value: function template(
      this: BunRigShellAdapter,
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) {
      return this.resource.template({ strings, values });
    },
    writable: true,
  },
  exec: {
    configurable: true,
    value: function exec(this: BunRigShellAdapter, args: string[], options: ShellOptions = {}) {
      return this.resource.exec({ args, options });
    },
    writable: true,
  },
  bash: {
    configurable: true,
    value: function bash(this: BunRigShellAdapter, command: string, options: ShellOptions = {}) {
      return this.resource.bash({ command, options });
    },
    writable: true,
  },
  json: {
    configurable: true,
    value: function json(this: BunRigShellAdapter, args: string[], options: ShellOptions = {}) {
      return this.resource.json({ args, options });
    },
    writable: true,
  },
});

export const BunRigShellClass = BunRigShellClassAdapter as unknown as BunRigShellConstructor;
