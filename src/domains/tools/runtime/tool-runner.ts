import { readFile } from "node:fs/promises";
import { Context, Effect, Layer, Result } from "effect";
import pino, { type Logger } from "pino";
import { RigError } from "../../../providers/errors/rig-error";
import { RigLoggerService, rigLoggerLayer } from "../../../providers/logging/rig-logger";
import {
  OutputTruncatorService,
  outputTruncatorLayer,
} from "../../../providers/output/output-truncator";
import { ToolIdentifierService, toolIdentifierLayer } from "../service/tool-identifier";
import type { CommandDefinition } from "../types/tool-types";
import type { RunCommandOptions, RunCommandResult } from "../types/tool-runner";
import { ToolLoaderService, type LoadedToolCommand } from "./tool-loader";
import { RigToolKitService } from "./tool-sdk";
import { ToolInputParserService, toolInputParserLayer } from "../service/tool-input-parser";
import {
  ToolExecutionResourcesService,
  toolExecutionResourcesLayer,
} from "./tool-execution-resources";
import { ToolExecutionError } from "../types/tool-execution";
import {
  ToolRunnerProtocolService,
  ToolRunnerValidationService,
  toolRunnerProtocolLayer,
} from "../service/tool-runner-protocol";

type RunInSession = (
  toolName: string,
  commandName: string,
  runOptions?: RunCommandOptions,
) => Effect.Effect<RunCommandResult>;

export class RunInputService extends Context.Service<
  RunInputService,
  {
    readonly read: (
      command: CommandDefinition,
      options: RunCommandOptions,
    ) => Effect.Effect<{ value: unknown; source: string }, RigError>;
  }
>()("@rendotdev/rig/tools/execution/RunInputService", {
  make: Effect.gen(function* () {
    const parser = yield* ToolInputParserService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const parseJsonInput = (source: string): unknown => {
      try {
        return JSON.parse(source);
      } catch (error) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Input JSON is invalid.",
          details: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    };
    const read = Effect.fn("RunInputService.read")(function* (
      command: CommandDefinition,
      options: RunCommandOptions,
    ) {
      const context = options.pipeContext ?? {};
      const args = yield* parser.interpolateArguments(context, options.args ?? []);
      const sourceCount = [
        Boolean(options.input),
        Boolean(options.inputFile),
        args.length > 0,
      ].filter(Boolean).length;
      if (sourceCount > 1) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: "Use args, --input, or --input-file, not more than one.",
        });
      }
      if (options.inputFile) {
        const source = yield* Effect.tryPromise({
          /* v8 ignore next -- the built CLI always uses Bun.file */
          try: () =>
            typeof Bun !== "undefined" && typeof Bun.file === "function"
              ? Bun.file(options.inputFile!).text()
              : readFile(options.inputFile!, "utf8"),
          catch: toError,
        });
        return {
          value: yield* Effect.try({
            try: () => parseJsonInput(source),
            catch: toError,
          }).pipe(Effect.flatMap((value) => parser.interpolate(context, value))),
          source: `--input-file ${options.inputFile}`,
        };
      }
      if (options.input) {
        return {
          value: yield* Effect.try({
            try: () => parseJsonInput(options.input!),
            catch: toError,
          }).pipe(Effect.flatMap((value) => parser.interpolate(context, value))),
          source: `--input '${options.input}'`,
        };
      }
      if (args.length > 0) {
        return {
          value: yield* parser.parseArguments(command.input, args),
          source: yield* parser.renderSource(args),
        };
      }
      return { value: {}, source: "--input '{}'" };
    });
    return { read } as const;
  }),
}) {
  static readonly layer = Layer.effect(RunInputService, RunInputService.make);
}

class ToolRunnerExecutionService extends Context.Service<
  ToolRunnerExecutionService,
  {
    readonly execute: (params: {
      toolName: string;
      commandName: string;
      tool: LoadedToolCommand["tool"];
      command: CommandDefinition;
      input: unknown;
      log: Logger;
      runNested: RunInSession;
    }) => Effect.Effect<RunCommandResult>;
  }
>()("@rendotdev/rig/tools/execution/ToolRunnerExecutionService", {
  make: Effect.gen(function* () {
    const resources = yield* ToolExecutionResourcesService;
    const toolkits = yield* RigToolKitService;
    const truncator = yield* OutputTruncatorService;
    const protocol = yield* ToolRunnerProtocolService;
    const validation = yield* ToolRunnerValidationService;
    const execute = Effect.fn("ToolRunnerExecutionService.execute")(function* (params: {
      toolName: string;
      commandName: string;
      tool: LoadedToolCommand["tool"];
      command: CommandDefinition;
      input: unknown;
      log: Logger;
      runNested: RunInSession;
    }) {
      const rig = yield* toolkits.create({
        run: (tool, command, runOptions) => params.runNested(tool, command, runOptions),
      });
      const program = Effect.gen(function* () {
        const { db, kv, cache, collections } = yield* resources.acquire({
          tool: params.tool,
          log: params.log,
        });
        const commandDatabase = db;
        params.log.info("Tool command started.");
        const data = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              params.command.run({
                input: params.input,
                env: params.tool.env,
                processEnv: process.env,
                cwd: process.cwd(),
                db: commandDatabase,
                kv,
                cache,
                log: params.log,
                rig,
                collections: collections ?? {},
              }),
            ),
          catch: (cause) => new ToolExecutionError({ operation: "command", cause }),
        });
        const output = yield* validation.output(params.command, data);
        params.log.info("Tool command finished.");
        const truncated = yield* truncator
          .truncate(output)
          .pipe(Effect.mapError((cause) => new ToolExecutionError({ operation: "output", cause })));
        return yield* protocol.success(truncated);
      }).pipe(
        Effect.withSpan("ToolRunnerService.run", {
          attributes: { "rig.tool": params.toolName, "rig.command": params.commandName },
        }),
        Effect.scoped,
        Effect.result,
      );
      const result = yield* program;
      return Result.isSuccess(result)
        ? result.success
        : yield* protocol.failure(params.log, result.failure.cause);
    });
    return { execute } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolRunnerExecutionService, ToolRunnerExecutionService.make);
}

export class ToolRunnerService extends Context.Service<
  ToolRunnerService,
  {
    readonly run: (
      toolName: string,
      commandName: string,
      options?: RunCommandOptions,
    ) => Effect.Effect<RunCommandResult>;
  }
>()("@rendotdev/rig/tools/execution/ToolRunnerService", {
  make: Effect.gen(function* () {
    const loader = yield* ToolLoaderService;
    const runInput = yield* RunInputService;
    const identifiers = yield* ToolIdentifierService;
    const truncator = yield* OutputTruncatorService;
    const loggers = yield* RigLoggerService;
    const protocol = yield* ToolRunnerProtocolService;
    const validation = yield* ToolRunnerValidationService;
    const execution = yield* ToolRunnerExecutionService;
    const commands = new Map<string, LoadedToolCommand>();
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const loadCommand = Effect.fn("ToolRunnerService.loadCommand")(function* (
      toolName: string,
      commandName: string,
    ) {
      const id = yield* identifiers.commandId(toolName, commandName);
      const cached = commands.get(id);
      if (cached) return cached;
      const loaded = yield* loader.loadCommand(toolName, commandName);
      commands.set(id, loaded);
      return loaded;
    });
    const run: RunInSession = Effect.fn("ToolRunnerService.run")(function* (
      toolName: string,
      commandName: string,
      runOptions: RunCommandOptions = {},
    ) {
      const log = yield* loggers
        .tool(toolName, commandName)
        .pipe(Effect.orElseSucceed(() => pino({ enabled: false })));
      const program = Effect.gen(function* () {
        const { tool, command } = yield* loadCommand(toolName, commandName);
        const input = yield* runInput.read(command, runOptions);
        const inputResult = command.input.safeParse(input.value);
        if (!inputResult.success) {
          return yield* new RigError({
            code: "VALIDATION_ERROR",
            message: "Invalid input.",
            details: yield* validation.details(inputResult.error),
          });
        }
        if (runOptions.dryRun) {
          const data = yield* protocol.dryRun({
            tool: toolName,
            command: commandName,
            input: inputResult.data,
            inputSource: input.source,
            id: yield* identifiers.commandId(toolName, commandName),
          });
          const truncated = yield* truncator.truncate(data).pipe(Effect.mapError(toError));
          return yield* protocol.success(truncated);
        }
        return yield* execution.execute({
          toolName,
          commandName,
          tool,
          command,
          input: inputResult.data,
          log,
          runNested: run,
        });
      });
      return yield* program.pipe(
        Effect.matchEffect({
          onFailure: (error) => protocol.failure(log, error),
          onSuccess: Effect.succeed,
        }),
      );
    });
    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolRunnerService, ToolRunnerService.make);
}

export const runInputLayer = RunInputService.layer.pipe(Layer.provide(toolInputParserLayer));
const toolRunnerExecutionLayer = ToolRunnerExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(toolExecutionResourcesLayer, outputTruncatorLayer, toolRunnerProtocolLayer),
  ),
);
export const toolRunnerLayer = ToolRunnerService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      runInputLayer,
      toolIdentifierLayer,
      toolExecutionResourcesLayer,
      rigLoggerLayer,
      outputTruncatorLayer,
      toolRunnerProtocolLayer,
      toolRunnerExecutionLayer,
    ),
  ),
);
