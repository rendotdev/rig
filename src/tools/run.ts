import { readFile } from "node:fs/promises";
import type { ConfigOptions } from "../config/config";
import { RigError, RigErrors } from "../errors/RigError";
import { EnvelopeFactory } from "../runtime/envelope";
import { PolicyChecker, type PolicyOptions } from "../runtime/policy";
import { BunRigShell } from "../runtime/shell";
import { ToolLoader } from "./loader";
import { CommandIds, type RigShell, type ShellOptions, type ShellResult } from "./types";

export type RunCommandOptions = ConfigOptions &
  PolicyOptions & {
    input?: string;
    inputFile?: string;
  };

export type RunCommandResult = {
  envelope: unknown;
  exitCode: number;
};

class GuardedShell implements RigShell {
  private readonly shell = new BunRigShell();

  constructor(
    private readonly tool: string,
    private readonly command: string,
    private readonly declaredSideEffects: string,
  ) {}

  async exec(args: string[], options?: ShellOptions): Promise<ShellResult> {
    this.ensureShellAllowed(args);
    return this.shell.exec(args, options);
  }

  async json(args: string[], options?: ShellOptions): Promise<unknown> {
    this.ensureShellAllowed(args);
    return this.shell.json(args, options);
  }

  private ensureShellAllowed(args: string[]): void {
    if (this.declaredSideEffects === "shell" || this.declaredSideEffects === "destructive") return;
    throw new RigError(
      "POLICY_CONFIRMATION_REQUIRED",
      "This command attempted to use the shell helper without declaring shell side effects.",
      {
        tool: this.tool,
        command: this.command,
        attemptedCommand: args,
        declaredSideEffects: this.declaredSideEffects,
      },
    );
  }
}

export class ToolRunner {
  private readonly loader: ToolLoader;
  private readonly policy: PolicyChecker;

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
    this.policy = new PolicyChecker();
  }

  async run(
    toolName: string,
    commandName: string,
    options: RunCommandOptions = {},
  ): Promise<RunCommandResult> {
    const start = performance.now();
    const id = CommandIds.from(toolName, commandName);

    try {
      const { tool, command } = await this.loader.loadCommand(toolName, commandName);
      const input = await this.readInput(options);

      this.policy.check({
        tool: toolName,
        command: commandName,
        sideEffects: command.sideEffects,
        options,
        inputSource: input.source,
      });

      const inputResult = command.input.safeParse(input.value);
      if (!inputResult.success) {
        throw new RigError("VALIDATION_ERROR", "Invalid input.", inputResult.error.flatten());
      }

      const data = await command.run({
        input: inputResult.data,
        env: process.env,
        cwd: process.cwd(),
        shell: new GuardedShell(toolName, commandName, command.sideEffects),
      });

      const outputResult = command.output.safeParse(data);
      if (!outputResult.success) {
        throw new RigError(
          "OUTPUT_VALIDATION_ERROR",
          "Command returned invalid output.",
          outputResult.error.flatten(),
        );
      }

      return {
        envelope: EnvelopeFactory.success({
          tool: tool.definition.name,
          command: commandName,
          id,
          data: outputResult.data,
          elapsedMs: this.elapsed(start),
        }),
        exitCode: 0,
      };
    } catch (error) {
      const rigError = this.asInputAwareRigError(error);
      return {
        envelope: EnvelopeFactory.error({
          tool: toolName,
          command: commandName,
          id,
          code: rigError.code,
          message: rigError.message,
          details: rigError.details,
          elapsedMs: this.elapsed(start),
        }),
        exitCode: 1,
      };
    }
  }

  private async readInput(options: RunCommandOptions): Promise<{ value: unknown; source: string }> {
    if (options.input && options.inputFile) {
      throw new RigError("INPUT_ERROR", "Use either --input or --input-file, not both.");
    }

    if (options.inputFile) {
      const raw = await readFile(options.inputFile, "utf8");
      return { value: JSON.parse(raw), source: `--input-file ${options.inputFile}` };
    }

    if (options.input) {
      return { value: JSON.parse(options.input), source: `--input '${options.input}'` };
    }

    return { value: {}, source: "--input '{}'" };
  }

  private elapsed(start: number): number {
    return Math.max(0, Math.round(performance.now() - start));
  }

  private asInputAwareRigError(error: unknown): RigError {
    if (error instanceof SyntaxError) {
      return new RigError("INPUT_ERROR", "Input JSON is invalid.", { message: error.message });
    }
    return RigErrors.from(error);
  }
}
