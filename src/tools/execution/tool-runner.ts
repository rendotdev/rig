import { readFile } from "node:fs/promises";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass, rigErrors } from "../../errors/RigError";
import { envelopeFactory } from "../../runtime/envelope";
import { RigLoggerFactoryClass } from "../../runtime/logger";
import { RigOutputTruncatorClass } from "../../runtime/truncation";
import { ToolCollectionServiceClass, type CollectionHandle } from "../collection";
import { ToolDatabaseServiceClass, UnavailableToolDatabaseFactoryClass } from "../db";
import { type ManagedRigToolCache, ToolCacheServiceClass } from "../cache";
import { type ManagedRigToolKvStore, ToolKvStoreServiceClass } from "../kv";
import { ToolLoaderClass } from "../loader";
import { schemaRenderer } from "../schema";
import { createRigToolKit } from "../sdk";
import { commandIds, type CommandDefinition, type RigToolDatabase } from "../types";

export type RunCommandOptions = ConfigOptions & {
  input?: string;
  inputFile?: string;
  args?: string[];
  dryRun?: boolean;
  pipeContext?: Record<string, unknown>;
};

export type RunCommandResult = {
  envelope: unknown;
  exitCode: number;
};

export class RunInputReaderClass {
  async read(
    command: CommandDefinition,
    options: RunCommandOptions,
  ): Promise<{ value: unknown; source: string }> {
    const resolver = new PipelineReferenceResolverClass(options.pipeContext ?? {});
    const args = resolver.interpolateStringArray(options.args ?? []);
    const inputSources = [
      Boolean(options.input),
      Boolean(options.inputFile),
      args.length > 0,
    ].filter(Boolean).length;

    if (inputSources > 1) {
      throw new RigErrorClass(
        "INPUT_ERROR",
        "Use args, --input, or --input-file, not more than one.",
      );
    }

    if (options.inputFile) {
      /* v8 ignore next -- the built CLI always uses Bun.file */
      const source =
        typeof Bun !== "undefined"
          ? await Bun.file(options.inputFile).text()
          : await readFile(options.inputFile, "utf8");
      const value = this.parseJson(source);
      return { value: resolver.interpolate(value), source: `--input-file ${options.inputFile}` };
    }

    if (options.input) {
      return {
        value: resolver.interpolate(this.parseJson(options.input)),
        source: `--input '${options.input}'`,
      };
    }

    if (args.length > 0) {
      const parser = new InputArgumentParserClass(command.input);
      return { value: parser.parse(args), source: new InputSourceRendererClass().render(args) };
    }

    return { value: {}, source: "--input '{}'" };
  }

  private parseJson(source: string): unknown {
    try {
      return JSON.parse(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RigErrorClass("INPUT_ERROR", "Input JSON is invalid.", { message });
    }
  }
}

class PipelineReferenceResolverClass {
  constructor(private readonly context: Record<string, unknown>) {}

  interpolateStringArray(values: string[]): string[] {
    return values.map((value) => String(this.interpolateString(value)));
  }

  interpolate(value: unknown): unknown {
    if (typeof value === "string") return this.interpolateString(value);
    if (Array.isArray(value)) return value.map((item) => this.interpolate(item));
    if (this.isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.interpolate(item)]),
      );
    }
    return value;
  }

  private interpolateString(value: string): unknown {
    const exact = value.match(/^@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?$/);
    if (exact) return this.lookup(exact[1], exact[2]);
    return value.replace(/@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?/g, (_match, id, path) =>
      String(this.lookup(id, path)),
    );
  }

  private lookup(id: string, path?: string): unknown {
    if (!(id in this.context)) {
      throw new RigErrorClass("INPUT_ERROR", `Pipeline reference is unknown: @${id}`, {
        reference: `@${id}`,
        available: Object.keys(this.context),
      });
    }

    let value = this.context[id];
    for (const part of path?.split(".").filter(Boolean) ?? []) {
      if (!this.isRecord(value) && !Array.isArray(value)) {
        throw new RigErrorClass("INPUT_ERROR", `Pipeline reference cannot access: @${id}.${path}`, {
          reference: `@${id}.${path}`,
          missing: part,
        });
      }
      value = (value as Record<string, unknown>)[part];
      if (value === undefined) {
        throw new RigErrorClass("INPUT_ERROR", `Pipeline reference is missing: @${id}.${path}`, {
          reference: `@${id}.${path}`,
          missing: part,
        });
      }
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}

class InputArgumentParserClass {
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
      throw new RigErrorClass(
        "INPUT_ERROR",
        "This command does not declare positional input fields.",
        {
          args,
        },
      );
    }

    if (args.length > fields.length) {
      throw new RigErrorClass("INPUT_ERROR", "Too many positional arguments.", {
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
      throw new RigErrorClass("INPUT_ERROR", "Argument keys must not be empty.", { arg });
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
    const jsonSchema = schemaRenderer.toJsonSchema(this.schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) return [];
    return Object.keys(jsonSchema.properties);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class InputSourceRendererClass {
  render(args: string[]): string {
    return args.map((arg) => this.shellArg(arg)).join(" ");
  }

  private shellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }
}

class ZodErrorPresenterClass {
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

class DryRunPresenterClass {
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
      id: commandIds.from(params.tool, params.command),
      input: params.input,
      commandLine: `rig run ${commandIds.from(params.tool, params.command)} ${params.inputSource}`,
    };
  }
}

class ToolExecutionSessionClass {
  constructor(readonly loader: ToolLoaderClass) {}
}

export class ToolRunnerClass {
  private readonly databases = new ToolDatabaseServiceClass();
  private readonly kvStores = new ToolKvStoreServiceClass();
  private readonly caches = new ToolCacheServiceClass();
  private readonly collections = new ToolCollectionServiceClass();
  private readonly loggerFactory: RigLoggerFactoryClass;
  private readonly inputReader = new RunInputReaderClass();
  private readonly outputTruncator = new RigOutputTruncatorClass();
  private readonly unavailableDatabases = new UnavailableToolDatabaseFactoryClass();

  constructor(private readonly options: ConfigOptions = {}) {
    this.loggerFactory = new RigLoggerFactoryClass(options);
  }

  async run(
    toolName: string,
    commandName: string,
    options: RunCommandOptions = {},
  ): Promise<RunCommandResult> {
    const session = new ToolExecutionSessionClass(new ToolLoaderClass(this.options));
    return this.runInSession(session, toolName, commandName, options);
  }

  private async runInSession(
    session: ToolExecutionSessionClass,
    toolName: string,
    commandName: string,
    options: RunCommandOptions,
  ): Promise<RunCommandResult> {
    let db: RigToolDatabase | undefined;
    let kv: ManagedRigToolKvStore | undefined;
    let cache: ManagedRigToolCache | undefined;
    let collectionHandles: Record<string, CollectionHandle<any>> | undefined;
    const log = this.loggerFactory.tool(toolName, commandName);
    try {
      const { tool, command } = await session.loader.loadCommand(toolName, commandName);
      const input = await this.inputReader.read(command, options);

      const inputResult = command.input.safeParse(input.value);
      if (!inputResult.success) {
        throw new RigErrorClass(
          "VALIDATION_ERROR",
          "Invalid input.",
          new ZodErrorPresenterClass().present(inputResult.error),
        );
      }

      if (options.dryRun) {
        const data = new DryRunPresenterClass().present({
          tool: toolName,
          command: commandName,
          input: inputResult.data,
          inputSource: input.source,
        });
        return {
          envelope: envelopeFactory.success({
            data: await this.outputTruncator.truncateData(data),
          }),
          exitCode: 0,
        };
      }

      const rig = createRigToolKit(this.options, {
        run: (nestedTool, nestedCommand, nestedOptions) =>
          this.runInSession(session, nestedTool, nestedCommand, nestedOptions),
      });
      db = await this.databases.setup(tool);
      kv = await this.kvStores.setup(tool);
      cache = await this.caches.setup(tool, log);
      collectionHandles = await this.collections.setup(tool);
      log.info("Tool command started.");
      const data = await command.run({
        input: inputResult.data,
        env: tool.env,
        processEnv: process.env,
        cwd: process.cwd(),
        db: db ?? this.unavailableDatabases.create(toolName),
        kv,
        cache,
        log,
        rig,
        collections: collectionHandles ?? {},
      });

      const outputResult = command.output.safeParse(data);
      if (!outputResult.success) {
        throw new RigErrorClass(
          "OUTPUT_VALIDATION_ERROR",
          "Command returned invalid output.",
          new ZodErrorPresenterClass().present(outputResult.error),
        );
      }

      log.info("Tool command finished.");
      return {
        envelope: envelopeFactory.success({
          data: await this.outputTruncator.truncateData(outputResult.data),
        }),
        exitCode: 0,
      };
    } catch (error) {
      const rigError = rigErrors.from(error);
      log.error({ err: rigError }, "Tool command failed.");
      return {
        envelope: envelopeFactory.error({
          code: rigError.code,
          message: rigError.message,
          details: rigError.details,
        }),
        exitCode: 1,
      };
    } finally {
      this.collections.close(collectionHandles);
      this.closeCache(cache);
      this.closeKv(kv);
      this.closeDatabase(db);
    }
  }

  private closeCache(cache: ManagedRigToolCache | undefined): void {
    try {
      cache?.close();
    } catch {
      // The command already finished. Ignore close failures so they do not mask command results.
    }
  }

  private closeKv(kv: ManagedRigToolKvStore | undefined): void {
    try {
      kv?.close();
    } catch {
      // The command already finished. Ignore close failures so they do not mask command results.
    }
  }

  private closeDatabase(db: RigToolDatabase | undefined): void {
    try {
      db?.close(false);
    } catch {
      // The command already finished. Ignore close failures so they do not mask command results.
    }
  }
}
