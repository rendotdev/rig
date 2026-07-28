import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ShellOptions, ShellResult } from "../../tools/types";
import { BunRigShellProvider } from "./shell";

export const RigShellOperation = Schema.Literals(["exec", "bash", "template", "json"]);
export type RigShellOperation = typeof RigShellOperation.Type;

export class RigShellError extends Schema.TaggedErrorClass<RigShellError>()("RigShellError", {
  operation: RigShellOperation,
  command: Schema.Array(Schema.String),
  cause: Schema.Defect(),
}) {}

export type RigShellServiceShape = Readonly<{
  exec: (args: string[], options?: ShellOptions) => Effect.Effect<ShellResult, RigShellError>;
  bash: (command: string, options?: ShellOptions) => Effect.Effect<ShellResult, RigShellError>;
  template: (
    strings: TemplateStringsArray,
    values: unknown[],
  ) => Effect.Effect<ShellResult, RigShellError>;
  json: (args: string[], options?: ShellOptions) => Effect.Effect<unknown, RigShellError>;
}>;

export class RigShellService extends Context.Service<RigShellService, RigShellServiceShape>()(
  "@rendotdev/rig/runtime/RigShellService",
) {
  public static readonly makeLayer = (
    implementation: RigShellServiceShape,
  ): Layer.Layer<RigShellService> => Layer.succeed(RigShellService, implementation);
}

function attempt<Result>(params: {
  operation: RigShellOperation;
  command: string[];
  run: (signal: AbortSignal) => Promise<Result>;
}): Effect.Effect<Result, RigShellError> {
  return Effect.tryPromise({
    try: params.run,
    catch: (cause) =>
      new RigShellError({ operation: params.operation, command: params.command, cause }),
  }).pipe(
    Effect.withSpan(`RigShellService.${params.operation}`, {
      attributes: { command: params.command },
    }),
  );
}

export function makeRigShellLayer(resource: BunRigShellProvider): Layer.Layer<RigShellService> {
  return RigShellService.makeLayer({
    exec: (args, options) =>
      attempt({
        operation: "exec",
        command: args.map((argument) => String(argument)),
        run: (signal) => resource.execWithSignal({ args, options, signal }),
      }),
    bash: (command, options) =>
      attempt({
        operation: "bash",
        command: [command],
        run: (signal) => resource.bashWithSignal({ command, options, signal }),
      }),
    template: (strings, values) => {
      const command = resource.renderTemplate({ strings, values });
      return attempt({
        operation: "template",
        command: [command],
        run: (signal) => resource.templateWithSignal({ strings, values, signal }),
      });
    },
    json: (args, options) =>
      attempt({
        operation: "json",
        command: args,
        run: (signal) => resource.jsonWithSignal({ args, options, signal }),
      }),
  });
}

export const RigShellLayer = makeRigShellLayer(new BunRigShellProvider());
