import { spawn } from "node:child_process";
import { RigError } from "../errors/RigError";
import type { RigShell, ShellOptions, ShellResult } from "../tools/types";

export class BunRigShell implements RigShell {
  constructor(private readonly defaults: ShellOptions = {}) {}

  async $(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult> {
    return this.bash(this.renderTemplateCommand(strings, values));
  }

  async exec(args: string[], options: ShellOptions = {}): Promise<ShellResult> {
    this.validateArgs(args);
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? this.defaults.maxOutputBytes ?? 1_048_576;
    const proc = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd ?? this.defaults.cwd ?? process.cwd(),
      env: { ...process.env, ...this.defaults.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        this.readStream(proc.stdout),
        this.readStream(proc.stderr),
        new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1))),
      ]);

      if (timedOut) {
        throw new RigError("SHELL_ERROR", `Command timed out after ${timeoutMs}ms.`, {
          command: args,
        });
      }

      return {
        command: args,
        stdout: this.trimOutput(stdout, maxOutputBytes),
        stderr: this.trimOutput(stderr, maxOutputBytes),
        exitCode,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async bash(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    return this.exec(["bash", "-lc", command], options);
  }

  async json(args: string[], options: ShellOptions = {}): Promise<unknown> {
    const result = await this.exec(args, options);
    if (result.exitCode !== 0) {
      throw new RigError("SHELL_ERROR", "Command failed before JSON could be parsed.", result);
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new RigError("SHELL_ERROR", "Command stdout was not valid JSON.", { result, error });
    }
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

  private async readStream(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private validateArgs(args: string[]): void {
    if (
      !Array.isArray(args) ||
      args.length === 0 ||
      args.some((arg) => typeof arg !== "string" || arg.length === 0)
    ) {
      throw new RigError(
        "SHELL_ERROR",
        "shell.exec expects a non-empty array of command arguments.",
        {
          args,
        },
      );
    }
  }

  private trimOutput(value: string, maxOutputBytes?: number): string {
    if (!maxOutputBytes) return value;
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength <= maxOutputBytes) return value;
    return `${value.slice(0, maxOutputBytes)}\n[rig: output truncated]`;
  }
}
