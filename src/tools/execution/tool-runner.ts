import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass, rigErrors } from "../../errors/RigError";
import { envelopeFactory } from "../../runtime/envelope";
import { RigLoggerFactoryClass } from "../../runtime/logger";
import { RigOutputTruncatorClass } from "../../runtime/truncation";
import { UnavailableToolDatabaseFactoryClass } from "../db";
import { ToolLoaderClass } from "../loader";
import { createRigToolKit } from "../sdk";
import { commandIds, type CommandDefinition } from "../types";
import { ToolExecutionError, ToolExecutionResources } from "./tool-execution-resources";
import {
  InputArgumentParserClass,
  InputSourceRendererClass,
  PipelineReferenceResolverClass,
} from "./tool-input-parser";

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
  private readonly commands = new Map<
    string,
    Awaited<ReturnType<ToolLoaderClass["loadCommand"]>>
  >();

  constructor(readonly loader: ToolLoaderClass) {}

  async loadCommand(toolName: string, commandName: string) {
    const id = commandIds.from(toolName, commandName);
    const cached = this.commands.get(id);
    if (cached) return cached;
    const loaded = await this.loader.loadCommand(toolName, commandName);
    this.commands.set(id, loaded);
    return loaded;
  }
}

export class ToolRunnerClass {
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
    const log = this.loggerFactory.tool(toolName, commandName);
    try {
      const { tool, command } = await session.loadCommand(toolName, commandName);
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
      return await this.execute({
        session,
        toolName,
        commandName,
        tool,
        command,
        input: inputResult.data,
        log,
      });
    } catch (error) {
      return this.failureResult(log, error);
    }
  }

  private async execute(params: {
    session: ToolExecutionSessionClass;
    toolName: string;
    commandName: string;
    tool: Awaited<ReturnType<ToolLoaderClass["loadCommand"]>>["tool"];
    command: CommandDefinition;
    input: unknown;
    log: ReturnType<RigLoggerFactoryClass["tool"]>;
  }): Promise<RunCommandResult> {
    const rig = createRigToolKit(this.options, {
      run: (nestedTool, nestedCommand, nestedOptions) =>
        this.runInSession(params.session, nestedTool, nestedCommand, nestedOptions),
    });
    const program = Effect.gen(
      function* (this: ToolRunnerClass) {
        const resources = yield* ToolExecutionResources;
        const { db, kv, cache, collections } = yield* resources.acquire({
          tool: params.tool,
          log: params.log,
        });
        params.log.info("Tool command started.");
        const data = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              params.command.run({
                input: params.input,
                env: params.tool.env,
                processEnv: process.env,
                cwd: process.cwd(),
                db: db ?? this.unavailableDatabases.create(params.toolName),
                kv,
                cache,
                log: params.log,
                rig,
                collections: collections ?? {},
              }),
            ),
          catch: (cause) => new ToolExecutionError({ operation: "command", cause }),
        });
        const output = yield* this.validateOutput(params.command, data);
        params.log.info("Tool command finished.");
        const truncated = yield* Effect.tryPromise({
          try: () => this.outputTruncator.truncateData(output),
          catch: (cause) => new ToolExecutionError({ operation: "output", cause }),
        });
        return {
          envelope: envelopeFactory.success({ data: truncated }),
          exitCode: 0,
        };
      }.bind(this),
    ).pipe(
      Effect.withSpan("ToolRunner.run", {
        attributes: { "rig.tool": params.toolName, "rig.command": params.commandName },
      }),
      Effect.scoped,
      // ToolRunnerClass is the Promise compatibility boundary for existing callers.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(ToolExecutionResources.layer),
      Effect.result,
    );
    const result = await Effect.runPromise(program);
    if (Result.isSuccess(result)) return result.success;
    return this.failureResult(params.log, result.failure.cause);
  }

  private validateOutput(command: CommandDefinition, data: unknown) {
    return Effect.try({
      try: () => command.output.safeParse(data),
      /* v8 ignore next -- Zod safeParse reports validation failures as data. */
      catch: (cause) => new ToolExecutionError({ operation: "output", cause }),
    }).pipe(
      Effect.flatMap((result) =>
        result.success
          ? Effect.succeed(result.data)
          : new ToolExecutionError({
              operation: "output",
              cause: new RigErrorClass(
                "OUTPUT_VALIDATION_ERROR",
                "Command returned invalid output.",
                new ZodErrorPresenterClass().present(result.error),
              ),
            }),
      ),
    );
  }

  private failureResult(
    log: ReturnType<RigLoggerFactoryClass["tool"]>,
    error: unknown,
  ): RunCommandResult {
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
  }
}
