import { spawn, type ChildProcess } from "node:child_process";
import { RigErrorClass } from "../../errors/RigError";
import type { RigShell, ShellOptions, ShellResult } from "../../tools/types";

const DefaultTimeoutMs = 30_000;
const DefaultMaxOutputBytes = 1_048_576;
const TerminationGraceMs = 100;
const TruncationMarker = "\n[rig: output truncated]";

class BoundedOutputCollectorClass {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  capture(buffer: Buffer): void {
    const remaining = Math.max(0, this.maxBytes - this.capturedBytes);
    if (remaining > 0) {
      const captured = buffer.subarray(0, remaining);
      this.chunks.push(captured);
      this.capturedBytes += captured.byteLength;
    }
    if (buffer.byteLength > remaining) this.truncated = true;
  }

  result(): string {
    const content = this.decodeUtf8Prefix(Buffer.concat(this.chunks, this.capturedBytes));
    return this.truncated ? `${content}${TruncationMarker}` : content;
  }

  private decodeUtf8Prefix(buffer: Buffer): string {
    const strictDecoder = new TextDecoder("utf-8", { fatal: true });
    for (let removed = 0; removed <= Math.min(3, buffer.byteLength); removed++) {
      try {
        return strictDecoder.decode(buffer.subarray(0, buffer.byteLength - removed));
      } catch {
        // A UTF-8 code point may be split at the byte boundary. Try the preceding boundary.
      }
    }
    return new TextDecoder().decode(buffer);
  }
}

class ManagedProcessClass {
  private readonly processGroup = process.platform !== "win32";
  private timedOut = false;
  private timeout?: NodeJS.Timeout;
  private escalation?: NodeJS.Timeout;
  private spawnError?: Error;

  constructor(
    private readonly child: ChildProcess,
    private readonly command: string[],
    private readonly timeoutMs: number,
  ) {}

  async wait(): Promise<number> {
    this.child.once("error", (error) => {
      this.spawnError = error;
    });
    this.timeout = setTimeout(() => this.terminate(), this.timeoutMs);

    try {
      const exitCode = await new Promise<number>((resolve) => {
        this.child.once("close", (code) => resolve(code ?? 1));
      });
      if (this.spawnError) {
        throw new RigErrorClass("SHELL_ERROR", `Command could not start: ${this.command[0]}`, {
          command: this.command,
          message: this.spawnError.message,
        });
      }
      if (this.timedOut) {
        throw new RigErrorClass("SHELL_ERROR", `Command timed out after ${this.timeoutMs}ms.`, {
          command: this.command,
        });
      }
      return exitCode;
    } finally {
      /* v8 ignore else -- every managed process installs a timeout */
      if (this.timeout) clearTimeout(this.timeout);
      if (this.escalation) clearTimeout(this.escalation);
    }
  }

  private terminate(): void {
    this.timedOut = true;
    this.signal("SIGTERM");
    this.escalation = setTimeout(() => this.signal("SIGKILL"), TerminationGraceMs);
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      /* v8 ignore else -- Windows does not expose POSIX process groups */
      if (this.processGroup && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      /* v8 ignore next -- the process may exit between close detection and signaling */
      return;
    }
  }
}

export class BunRigShellClass implements RigShell {
  constructor(private readonly defaults: ShellOptions = {}) {}

  async $(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult> {
    return this.bash(this.renderTemplateCommand(strings, values));
  }

  async exec(args: string[], options: ShellOptions = {}): Promise<ShellResult> {
    this.validateArgs(args);
    return this.runProcess(args, options);
  }

  async bash(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    return this.runProcess(["bash", "-lc", command], options, [command]);
  }

  async json(args: string[], options: ShellOptions = {}): Promise<unknown> {
    const result = await this.exec(args, options);
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

  private async runProcess(
    args: string[],
    options: ShellOptions = {},
    reportedCommand = args,
  ): Promise<ShellResult> {
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? DefaultTimeoutMs;
    const maxOutputBytes =
      options.maxOutputBytes ?? this.defaults.maxOutputBytes ?? DefaultMaxOutputBytes;
    const child = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd ?? this.defaults.cwd ?? process.cwd(),
      env: { ...process.env, ...this.defaults.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = new BoundedOutputCollectorClass(maxOutputBytes);
    const stderr = new BoundedOutputCollectorClass(maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => stdout.capture(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.capture(chunk));
    const exitCode = await new ManagedProcessClass(child, reportedCommand, timeoutMs).wait();

    return {
      command: reportedCommand,
      stdout: stdout.result(),
      stderr: stderr.result(),
      exitCode,
    };
  }

  private renderTemplateCommand(strings: TemplateStringsArray, values: unknown[]): string {
    return strings.reduce((command, part, index) => {
      const value = index < values.length ? this.renderTemplateValue(values[index]) : "";
      return `${command}${part}${value}`;
    }, "");
  }

  private renderTemplateValue(value: unknown): string {
    if (Array.isArray(value)) return value.map((item) => this.shellQuote(String(item))).join(" ");
    return this.shellQuote(String(value));
  }

  private shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  private validateArgs(args: string[]): void {
    if (
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some((arg) => typeof arg !== "string" || arg.length === 0)
    ) {
      throw new RigErrorClass(
        "SHELL_ERROR",
        "shell.exec expects a non-empty array of command arguments.",
        {
          args,
        },
      );
    }
  }
}
