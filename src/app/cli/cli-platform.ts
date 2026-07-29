import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import {
  RigError,
  RigErrorNormalizationService,
  rigErrorNormalizationLayer,
} from "../../providers/errors/rig-error";

export class CliEnvironmentConfigService extends Context.Service<
  CliEnvironmentConfigService,
  { readonly env: NodeJS.ProcessEnv; readonly argv: readonly string[] }
>()("@rendotdev/rig/application/CliEnvironmentConfigService", {
  make: Effect.sync(() => ({ env: process.env, argv: process.argv })),
}) {
  static readonly layer = Layer.effect(
    CliEnvironmentConfigService,
    CliEnvironmentConfigService.make,
  );
}

export class CliPlatformService extends Context.Service<
  CliPlatformService,
  {
    readonly cwd: Effect.Effect<string>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly readText: (path: string) => Effect.Effect<string, RigError>;
    readonly log: (value: string) => Effect.Effect<void>;
    readonly error: (value: string) => Effect.Effect<void>;
    readonly printJson: (value: unknown) => Effect.Effect<void>;
    readonly printQueryResult: (value: unknown) => Effect.Effect<void>;
    readonly setExitCode: (code: number) => Effect.Effect<void>;
    readonly fail: (cause: unknown) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliPlatformService", {
  make: Effect.gen(function* () {
    const errors = yield* RigErrorNormalizationService;
    const toReadError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const cwd = Effect.sync(() => process.cwd()).pipe(Effect.withSpan("CliPlatformService.cwd"));
    const exists = Effect.fn("CliPlatformService.exists")(function* (path: string) {
      return existsSync(path);
    });
    const readText = Effect.fn("CliPlatformService.readText")(function* (path: string) {
      return yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: toReadError });
    });
    const log = Effect.fn("CliPlatformService.log")(function* (value: string) {
      yield* Effect.sync(() => console.log(value));
    });
    const error = Effect.fn("CliPlatformService.error")(function* (value: string) {
      yield* Effect.sync(() => console.error(value));
    });
    const printJson = Effect.fn("CliPlatformService.printJson")(function* (value: unknown) {
      yield* log(JSON.stringify(value, null, 2));
    });
    const printQueryResult = Effect.fn("CliPlatformService.printQueryResult")(function* (
      value: unknown,
    ) {
      const isScalarValue =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      if (isScalarValue) {
        yield* log(String(value));
        return;
      }
      yield* printJson(value);
    });
    const setExitCode = Effect.fn("CliPlatformService.setExitCode")(function* (code: number) {
      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    });
    const fail = Effect.fn("CliPlatformService.fail")(function* (cause: unknown) {
      const rigError = yield* errors.normalize(cause);
      yield* error(`${rigError.code}: ${rigError.message}`);
      if (rigError.details !== undefined) yield* error(JSON.stringify(rigError.details, null, 2));
      yield* setExitCode(1);
    });
    return {
      cwd,
      exists,
      readText,
      log,
      error,
      printJson,
      printQueryResult,
      setExitCode,
      fail,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliPlatformService, CliPlatformService.make);
}

export const cliPlatformLayer = CliPlatformService.layer.pipe(
  Layer.provide(rigErrorNormalizationLayer),
);
