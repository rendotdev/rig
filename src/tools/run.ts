import { readFile } from "node:fs/promises";
import type { ConfigOptions } from "../config/config";
import { RigError, RigErrors } from "../errors/RigError";
import { EnvelopeFactory } from "../runtime/envelope";
import { RigOutputTruncator } from "../runtime/truncation";
import { ToolLoader } from "./loader";
import { SchemaRenderer } from "./schema";
import { createRigToolKit } from "./sdk";
import { CommandIds, type CommandDefinition } from "./types";

export type RunCommandOptions = ConfigOptions & {
  input?: string;
  inputFile?: string;
  args?: string[];
  dryRun?: boolean;
};

export type RunCommandResult = {
  envelope: unknown;
  exitCode: number;
};

class RunInputReader {
  async read(
    command: CommandDefinition,
    options: RunCommandOptions,
  ): Promise<{ value: unknown; source: string }> {
    const args = options.args ?? [];
    const inputSources = [
      Boolean(options.input),
      Boolean(options.inputFile),
      args.length > 0,
    ].filter(Boolean).length;

    if (inputSources > 1) {
      throw new RigError("INPUT_ERROR", "Use args, --input, or --input-file, not more than one.");
    }

    if (options.inputFile) {
      /* v8 ignore next 3 */
      const value =
        typeof Bun !== "undefined"
          ? await Bun.file(options.inputFile).json()
          : JSON.parse(await readFile(options.inputFile, "utf8"));
      return { value, source: `--input-file ${options.inputFile}` };
    }

    if (options.input) {
      return { value: JSON.parse(options.input), source: `--input '${options.input}'` };
    }

    if (args.length > 0) {
      const parser = new InputArgumentParser(command.input);
      return { value: parser.parse(args), source: new InputSourceRenderer().render(args) };
    }

    return { value: {}, source: "--input '{}'" };
  }
}

class InputArgumentParser {
  constructor(private readonly schema: unknown) {}

  parse(args: string[]): unknown {
    if (args.length === 1) {
      const maybeJson = this.tryParseJson(args[0]);
      if (maybeJson.parsed && this.shouldUseJsonValue(maybeJson.value)) return maybeJson.value;
    }

    if (args.every((arg) => arg.includes("="))) {
      return Object.fromEntries(args.map((arg) => this.parseKeyValueArg(arg)));
    }

    const fields = this.inputFieldNames();
    if (fields.length === 0) {
      if (args.length === 1) return this.parseScalar(args[0]);
      throw new RigError("INPUT_ERROR", "This command does not declare positional input fields.", {
        args,
      });
    }

    if (args.length > fields.length) {
      throw new RigError("INPUT_ERROR", "Too many positional arguments.", {
        args,
        expectedFields: fields,
      });
    }

    return Object.fromEntries(args.map((arg, index) => [fields[index], this.parseScalar(arg)]));
  }

  private parseKeyValueArg(arg: string): [string, unknown] {
    const separatorIndex = arg.indexOf("=");
    const key = arg.slice(0, separatorIndex);
    const value = arg.slice(separatorIndex + 1);
    if (!key) {
      throw new RigError("INPUT_ERROR", "Argument keys must not be empty.", { arg });
    }
    return [key, this.parseScalar(value)];
  }

  private parseScalar(value: string): unknown {
    const maybeJson = this.tryParseJson(value);
    return maybeJson.parsed ? maybeJson.value : value;
  }

  private tryParseJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
    try {
      return { parsed: true, value: JSON.parse(value) };
    } catch {
      return { parsed: false };
    }
  }

  private shouldUseJsonValue(value: unknown): boolean {
    return typeof value === "object" && value !== null;
  }

  private inputFieldNames(): string[] {
    const jsonSchema = SchemaRenderer.toJsonSchema(this.schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) return [];
    return Object.keys(jsonSchema.properties);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class InputSourceRenderer {
  render(args: string[]): string {
    return args.map((arg) => this.shellArg(arg)).join(" ");
  }

  private shellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }
}

class ZodErrorPresenter {
  present(error: { flatten: () => unknown; issues?: unknown[] }): Record<string, unknown> {
    return {
      ...this.flattenObject(error.flatten()),
      /* v8 ignore next */
      issues: (error.issues ?? []).map((issue) => this.presentIssue(issue)),
    };
  }

  private presentIssue(issue: unknown): Record<string, unknown> {
    /* v8 ignore next */
    if (!this.isRecord(issue)) return { message: String(issue) };
    return Object.fromEntries(
      Object.entries({
        /* v8 ignore next */
        path: Array.isArray(issue.path) ? issue.path.join(".") : "",
        code: issue.code,
        message: issue.message,
        expected: issue.expected,
        received: issue.received,
      }).filter(([, value]) => value !== undefined),
    );
  }

  private flattenObject(value: unknown): Record<string, unknown> {
    /* v8 ignore next */
    return this.isRecord(value) ? value : {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class DryRunPresenter {
  present(params: {
    tool: string;
    command: string;
    input: unknown;
    inputSource: string;
  }): Record<string, unknown> {
    return {
      dryRun: true,
      wouldRun: false,
      tool: params.tool,
      command: params.command,
      id: CommandIds.from(params.tool, params.command),
      input: params.input,
      commandLine: `rig run ${CommandIds.from(params.tool, params.command)} ${params.inputSource}`,
    };
  }
}

export class ToolRunner {
  private readonly loader: ToolLoader;
  private readonly inputReader = new RunInputReader();
  private readonly outputTruncator = new RigOutputTruncator();

  constructor(private readonly options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
  }

  async run(
    toolName: string,
    commandName: string,
    options: RunCommandOptions = {},
  ): Promise<RunCommandResult> {
    try {
      const { command } = await this.loader.loadCommand(toolName, commandName);
      const input = await this.inputReader.read(command, options);

      const inputResult = command.input.safeParse(input.value);
      if (!inputResult.success) {
        throw new RigError(
          "VALIDATION_ERROR",
          "Invalid input.",
          new ZodErrorPresenter().present(inputResult.error),
        );
      }

      if (options.dryRun) {
        const data = new DryRunPresenter().present({
          tool: toolName,
          command: commandName,
          input: inputResult.data,
          inputSource: input.source,
        });
        return {
          envelope: EnvelopeFactory.success({
            data: await this.outputTruncator.truncateData(data),
          }),
          exitCode: 0,
        };
      }

      const rig = createRigToolKit(this.options);
      const data = await command.run({
        input: inputResult.data,
        env: process.env,
        cwd: process.cwd(),
        rig,
      });

      const outputResult = command.output.safeParse(data);
      if (!outputResult.success) {
        throw new RigError(
          "OUTPUT_VALIDATION_ERROR",
          "Command returned invalid output.",
          new ZodErrorPresenter().present(outputResult.error),
        );
      }

      return {
        envelope: EnvelopeFactory.success({
          data: await this.outputTruncator.truncateData(outputResult.data),
        }),
        exitCode: 0,
      };
    } catch (error) {
      const rigError = this.asInputAwareRigError(error);
      return {
        envelope: EnvelopeFactory.error({
          code: rigError.code,
          message: rigError.message,
          details: rigError.details,
        }),
        exitCode: 1,
      };
    }
  }

  private asInputAwareRigError(error: unknown): RigError {
    if (error instanceof SyntaxError) {
      return new RigError("INPUT_ERROR", "Input JSON is invalid.", { message: error.message });
    }
    return RigErrors.from(error);
  }
}
