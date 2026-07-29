import { Context, Effect, Layer, Predicate } from "effect";
import type { Logger } from "pino";
import {
  RigError,
  RigErrorNormalizationService,
  rigErrorNormalizationLayer,
} from "../../../providers/errors/rig-error";
import type { CommandDefinition } from "../types/tool-types";
import type { RunCommandResult } from "../types/tool-runner";
import { ToolExecutionError } from "../types/tool-execution";

export class ToolRunnerProtocolService extends Context.Service<
  ToolRunnerProtocolService,
  {
    readonly dryRun: (params: {
      tool: string;
      command: string;
      input: unknown;
      inputSource: string;
      id: string;
    }) => Effect.Effect<Record<string, unknown>>;
    readonly failure: (log: Logger, error: unknown) => Effect.Effect<RunCommandResult>;
    readonly success: (data: unknown) => Effect.Effect<RunCommandResult>;
  }
>()("@rendotdev/rig/tools/execution/ToolRunnerProtocolService", {
  make: Effect.gen(function* () {
    const errors = yield* RigErrorNormalizationService;
    const successEnvelope = (data: unknown) => ({ data, errors: [] as [] });
    const errorEnvelope = (error: RigError) => ({
      data: null,
      errors: [{ code: error.code, message: error.message, details: error.details }],
    });
    const dryRun = Effect.fn("ToolRunnerProtocolService.dryRun")(function* (params: {
      tool: string;
      command: string;
      input: unknown;
      inputSource: string;
      id: string;
    }) {
      return {
        dryRun: true,
        wouldRun: false,
        tool: params.tool,
        command: params.command,
        id: params.id,
        input: params.input,
        commandLine: `rig run ${params.id} ${params.inputSource}`,
      };
    });
    const failure = Effect.fn("ToolRunnerProtocolService.failure")(function* (
      log: Logger,
      error: unknown,
    ) {
      const rigError = yield* errors.normalize(error);
      log.error({ err: rigError }, "Tool command failed.");
      return { envelope: errorEnvelope(rigError), exitCode: 1 };
    });
    const success = Effect.fn("ToolRunnerProtocolService.success")(function* (data: unknown) {
      return { envelope: successEnvelope(data), exitCode: 0 };
    });
    return { dryRun, failure, success } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolRunnerProtocolService, ToolRunnerProtocolService.make);
}

export class ToolRunnerValidationService extends Context.Service<
  ToolRunnerValidationService,
  {
    readonly details: (error: {
      flatten: () => unknown;
      issues?: unknown[];
    }) => Effect.Effect<Record<string, unknown>>;
    readonly output: (
      command: CommandDefinition,
      data: unknown,
    ) => Effect.Effect<unknown, ToolExecutionError>;
  }
>()("@rendotdev/rig/tools/execution/ToolRunnerValidationService", {
  make: Effect.gen(function* () {
    const presentIssue = (issue: unknown): Record<string, unknown> => {
      /* v8 ignore next */
      if (!Predicate.isObject(issue)) return { message: String(issue) };
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
    };
    const present = (error: { flatten: () => unknown; issues?: unknown[] }) => {
      const flattened = error.flatten();
      return {
        /* v8 ignore next -- Zod flatten always returns a record */
        ...(Predicate.isObject(flattened) ? flattened : {}),
        /* v8 ignore next */
        issues: (error.issues ?? []).map(presentIssue),
      };
    };
    const details = Effect.fn("ToolRunnerValidationService.details")(function* (error: {
      flatten: () => unknown;
      issues?: unknown[];
    }) {
      return present(error);
    });
    const output = Effect.fn("ToolRunnerValidationService.output")(function* (
      command: CommandDefinition,
      data: unknown,
    ) {
      const result = yield* Effect.try({
        try: () => command.output.safeParse(data),
        catch: (cause) => new ToolExecutionError({ operation: "output", cause }),
      });
      if (result.success) return result.data;
      return yield* new ToolExecutionError({
        operation: "output",
        cause: new RigError({
          code: "OUTPUT_VALIDATION_ERROR",
          message: "Command returned invalid output.",
          details: present(result.error),
        }),
      });
    });
    return { details, output } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolRunnerValidationService,
    ToolRunnerValidationService.make,
  );
}

const protocolLayer = ToolRunnerProtocolService.layer.pipe(
  Layer.provide(rigErrorNormalizationLayer),
);
export const toolRunnerProtocolLayer = Layer.merge(
  protocolLayer,
  ToolRunnerValidationService.layer,
);
