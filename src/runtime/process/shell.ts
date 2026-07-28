import { spawn, type ChildProcess } from "node:child_process";
import { RigErrorClass } from "../../errors/RigError";
import type { RigShell, ShellOptions, ShellResult } from "../../tools/types";
import { BoundedOutputCollectorSingleton, ManagedProcessFactory } from "./managed-process";

const DefaultTimeoutMs = 30_000;
const DefaultMaxOutputBytes = 1_048_576;

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
    cancel(params: {}): void;
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

export class BunRigShellProvider {
  public static readonly defaultConstruction = {
    params: {} as ShellOptions,
    deps: BunRigShellProductionDeps,
  };
  protected readonly params: (typeof BunRigShellProvider.defaultConstruction)["params"];
  protected readonly deps: (typeof BunRigShellProvider.defaultConstruction)["deps"];

  public constructor(
    props: typeof BunRigShellProvider.defaultConstruction = BunRigShellProvider.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
  }

  private async runProcess(params: {
    args: string[];
    options?: ShellOptions;
    reportedCommand?: string[];
    signal?: AbortSignal;
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
    const cancel = () => managed.cancel({});
    if (params.signal?.aborted) {
      cancel();
    } else {
      params.signal?.addEventListener("abort", cancel, { once: true });
    }
    let exitCode: number;
    try {
      exitCode = await managed.wait({});
    } finally {
      params.signal?.removeEventListener("abort", cancel);
    }

    return {
      command: reportedCommand,
      stdout: stdout.result({}),
      stderr: stderr.result({}),
      exitCode,
    };
  }

  public execWithSignal(params: {
    args: string[];
    options?: ShellOptions;
    signal?: AbortSignal;
  }): Promise<ShellResult> {
    validateArgs({ args: params.args });
    return this.runProcess(params);
  }

  public bashWithSignal(params: {
    command: string;
    options?: ShellOptions;
    signal?: AbortSignal;
  }): Promise<ShellResult> {
    return this.runProcess({
      args: ["bash", "-lc", params.command],
      options: params.options,
      reportedCommand: [params.command],
      signal: params.signal,
    });
  }

  public templateWithSignal(params: {
    strings: TemplateStringsArray;
    values: unknown[];
    signal?: AbortSignal;
  }): Promise<ShellResult> {
    const command = renderTemplateCommand(params);
    return this.bashWithSignal({ command, signal: params.signal });
  }

  public renderTemplate(params: { strings: TemplateStringsArray; values: unknown[] }): string {
    return renderTemplateCommand(params);
  }

  public async jsonWithSignal(params: {
    args: string[];
    options?: ShellOptions;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const result = await this.execWithSignal(params);
    if (result.exitCode !== 0) {
      throw new RigErrorClass("SHELL_ERROR", "Command failed before JSON could be parsed.", result);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new RigErrorClass("SHELL_ERROR", "Command stdout was not valid JSON.", {
        result,
        error,
      });
    }
  }

  public async exec(params: { args: string[]; options?: ShellOptions }): Promise<ShellResult> {
    return await this.execWithSignal(params);
  }

  public bash(params: { command: string; options?: ShellOptions }): Promise<ShellResult> {
    return this.bashWithSignal(params);
  }

  public template(params: {
    strings: TemplateStringsArray;
    values: unknown[];
  }): Promise<ShellResult> {
    return this.templateWithSignal(params);
  }

  public json(params: { args: string[]; options?: ShellOptions }): Promise<unknown> {
    return this.jsonWithSignal(params);
  }
}

export type BunRigShellClass = RigShell;

type BunRigShellConstructor = {
  new (defaults?: ShellOptions): BunRigShellClass;
  readonly prototype: BunRigShellClass;
};

type BunRigShellAdapter = BunRigShellClass & {
  readonly resource: BunRigShellProvider;
};

const BunRigShellClassAdapter = function constructBunRigShell(
  this: BunRigShellAdapter,
  defaults: ShellOptions = {},
): void {
  const resource = new BunRigShellProvider({ params: defaults, deps: BunRigShellProductionDeps });
  Object.defineProperty(this, "resource", {
    value: resource,
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
