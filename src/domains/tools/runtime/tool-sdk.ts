import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve as resolvePathValue } from "node:path";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import {
  RigPathsConfigService,
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  RigPathsService,
  type PathOptions,
} from "../../../providers/paths/rig-paths";
import { RigError } from "../../../providers/errors/rig-error";
import { RigShellService, rigShellLayer } from "../../../providers/process/rig-shell-service";
import type { SuccessEnvelope } from "../types/envelope";
import {
  type NormalizedToolDefinitionInput,
  type RigArgBuilder,
  type RigPathHelper,
  type RigRunOptions,
  type RigSchema,
  type RigToolKit,
  type ToolCollectionDefinitions,
  type ToolCommandMap,
  type ToolDefinitionInput,
  type ToolFactory,
  type ToolModuleDefault,
} from "../types/tool-types";

export { z };

export type RigCommandRunnerDependencies = {
  run(
    tool: string,
    command: string,
    options: PathOptions & { args?: string[]; input?: string; dryRun?: boolean },
  ): Promise<{ envelope: unknown; exitCode: number }>;
};

export type RigCommandRunnerEffectDependencies = {
  run(
    tool: string,
    command: string,
    options: PathOptions & { args?: string[]; input?: string; dryRun?: boolean },
  ): Effect.Effect<{ envelope: unknown; exitCode: number }>;
};

class RigArgumentBuilderService extends Context.Service<
  RigArgumentBuilderService,
  { readonly create: Effect.Effect<RigArgBuilder> }
>()("@rendotdev/rig/tools/sdk/RigArgumentBuilderService", {
  make: Effect.gen(function* () {
    const create = Effect.sync(() => {
      const values: string[] = [];
      const builder: RigArgBuilder = {
        raw: (...items) => {
          values.push(...items);
          return builder;
        },
        flag: (name, enabled = true) => {
          if (enabled) values.push(name);
          return builder;
        },
        value: (name, value) => {
          const hasValue = value !== undefined && value !== null;
          if (hasValue) values.push(name, String(value));
          return builder;
        },
        values: (name, items) => {
          for (const value of items ?? []) values.push(name, value);
          return builder;
        },
        toArray: () => [...values],
      };
      return builder;
    }).pipe(Effect.withSpan("RigArgumentBuilderService.create"));
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigArgumentBuilderService, RigArgumentBuilderService.make);
}

class RigPathHelperService extends Context.Service<
  RigPathHelperService,
  {
    readonly home: Effect.Effect<string>;
    readonly resolvePath: (cwd: string, pathValue: string) => Effect.Effect<string>;
    readonly ensureParent: (pathValue: string) => Effect.Effect<void, RigError>;
    readonly size: (pathValue: string) => Effect.Effect<number>;
  }
>()("@rendotdev/rig/tools/sdk/RigPathHelperService", {
  make: Effect.gen(function* () {
    const pathValues = yield* RigPathsConfigService;
    const paths = yield* RigPathsService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const home = Effect.succeed(pathValues.homeDir).pipe(
      Effect.withSpan("RigPathHelperService.home"),
    );
    const resolvePath = Effect.fn("RigPathHelperService.resolvePath")(function* (
      cwd: string,
      pathValue: string,
    ) {
      const expanded = yield* paths.expandTilde(pathValue);
      return isAbsolute(expanded) ? expanded : resolvePathValue(cwd, expanded);
    });
    const ensureParent = Effect.fn("RigPathHelperService.ensureParent")(function* (
      pathValue: string,
    ) {
      const parent = yield* paths.parentDir(pathValue);
      yield* Effect.tryPromise({
        try: () => mkdir(parent, { recursive: true }),
        catch: toError,
      });
    });
    const size = Effect.fn("RigPathHelperService.size")(function* (pathValue: string) {
      return existsSync(pathValue) ? statSync(pathValue).size : 0;
    });
    return { home, resolvePath, ensureParent, size } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigPathHelperService, RigPathHelperService.make);
}

class RigRunTargetService extends Context.Service<
  RigRunTargetService,
  {
    readonly parse: (
      options: RigRunOptions,
    ) => Effect.Effect<{ tool: string; command: string; id: string }, RigError>;
  }
>()("@rendotdev/rig/tools/sdk/RigRunTargetService", {
  make: Effect.gen(function* () {
    const parse = Effect.fn("RigRunTargetService.parse")(function* (options: RigRunOptions) {
      const id = options.tool ? `${options.tool}.${options.command}` : options.command;
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(id);
      if (!match) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: `Command id must use <tool>.<command>: ${id}`,
        });
      }
      return { tool: match[1]!, command: match[2]!, id };
    });
    return { parse } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigRunTargetService, RigRunTargetService.make);
}

export class RigToolKitService extends Context.Service<
  RigToolKitService,
  {
    readonly create: (runner?: RigCommandRunnerEffectDependencies) => Effect.Effect<RigToolKit>;
  }
>()("@rendotdev/rig/tools/sdk/RigToolKitService", {
  make: Effect.gen(function* () {
    const shell = yield* RigShellService;
    const argumentBuilders = yield* RigArgumentBuilderService;
    const pathHelpers = yield* RigPathHelperService;
    const targets = yield* RigRunTargetService;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const runSync = Effect.runSyncWith(runtimeContext);
    const normalizeToolDefinition = <
      Env extends RigSchema,
      Collections extends ToolCollectionDefinitions,
      Commands extends ToolCommandMap,
    >(
      definition: ToolDefinitionInput<Env, Collections, Commands>,
    ): NormalizedToolDefinitionInput<Env, Collections, Commands> =>
      (typeof definition.commands === "function"
        ? { ...definition, commands: definition.commands((command) => command) }
        : definition) as NormalizedToolDefinitionInput<Env, Collections, Commands>;
    const create = Effect.fn("RigToolKitService.create")(function* (
      runner?: RigCommandRunnerEffectDependencies,
    ) {
      const runShell = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => runPromise(effect);
      const pathHelper: RigPathHelper = {
        home: () => runSync(pathHelpers.home),
        resolve: (cwd, pathValue) => runSync(pathHelpers.resolvePath(cwd, pathValue)),
        ensureParent: (pathValue) => runPromise(pathHelpers.ensureParent(pathValue)),
        size: (pathValue) => runSync(pathHelpers.size(pathValue)),
      };
      const toolkit: RigToolKit = {
        z,
        defineTool: normalizeToolDefinition,
        defineCommand: (definition) => definition,
        run: <Result = unknown>(options: RigRunOptions): Promise<Result> => {
          const target = runSync(targets.parse(options));
          if (!runner) {
            return Promise.reject(
              new RigError({
                code: "TOOL_RUN_ERROR",
                message: `Rig tool command runner is unavailable: ${target.id}`,
              }),
            );
          }
          return runPromise(
            runner.run(target.tool, target.command, {
              args: options.args,
              input: options.input === undefined ? undefined : JSON.stringify(options.input),
              dryRun: options.dryRun,
            }),
          ).then((result) => {
            if (result.exitCode === 0) return (result.envelope as SuccessEnvelope).data as Result;
            throw new RigError({
              code: "TOOL_RUN_ERROR",
              message: `Rig tool command failed: ${target.id}`,
              details: { command: target.id, envelope: result.envelope },
            });
          });
        },
        $: (strings, ...values) =>
          runShell(shell.template(strings, values).pipe(Effect.mapError((error) => error.cause))),
        args: () => runSync(argumentBuilders.create),
        paths: pathHelper,
        shell: {
          exec: (args, options) =>
            runShell(shell.exec(args, options).pipe(Effect.mapError((error) => error.cause))),
          bash: (command, options) =>
            runShell(shell.bash(command, options).pipe(Effect.mapError((error) => error.cause))),
          json: (args, options) =>
            runShell(shell.json(args, options).pipe(Effect.mapError((error) => error.cause))),
          $: (strings, ...values) =>
            runShell(shell.template(strings, values).pipe(Effect.mapError((error) => error.cause))),
        },
      };
      return toolkit;
    });
    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigToolKitService, RigToolKitService.make);
}

const rigPathHelperLayer = RigPathHelperService.layer;
export const rigToolKitLayer = RigToolKitService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      RigArgumentBuilderService.layer,
      rigPathHelperLayer,
      RigRunTargetService.layer,
      rigShellLayer,
    ),
  ),
);

export function createRigToolKit(
  options: PathOptions = {},
  runner?: RigCommandRunnerDependencies,
): RigToolKit {
  const pathOptionsLayer = Layer.succeed(RigPathsOptionsConfigService, {
    homeDir: options.homeDir,
  });
  const pathPlatformLayer = RigPathsPlatformService.layer;
  const pathConfigLayer = RigPathsConfigService.layer.pipe(
    Layer.provide(Layer.merge(pathOptionsLayer, pathPlatformLayer)),
  );
  const pathLayer = RigPathsService.layer.pipe(
    Layer.provide(Layer.mergeAll(pathOptionsLayer, pathPlatformLayer, pathConfigLayer)),
  );
  const layer = rigToolKitLayer.pipe(Layer.provide(Layer.merge(pathConfigLayer, pathLayer)));
  const effectRunner = runner
    ? {
        run: (tool: string, command: string, runOptions: PathOptions) =>
          Effect.promise(() => runner.run(tool, command, runOptions)),
      }
    : undefined;
  return Effect.runSync(
    RigToolKitService.use((service) => service.create(effectRunner)).pipe(Effect.provide(layer)),
  );
}

export const rig = createRigToolKit();

export function defineTool<
  Env extends RigSchema = RigSchema,
  Collections extends ToolCollectionDefinitions = ToolCollectionDefinitions,
  const Commands extends ToolCommandMap = ToolCommandMap,
>(
  definition: ToolDefinitionInput<Env, Collections, Commands>,
): NormalizedToolDefinitionInput<Env, Collections, Commands>;
export function defineTool(factory: ToolFactory): ToolFactory;
export function defineTool(value: ToolModuleDefault): ToolModuleDefault {
  return typeof value === "function" ? value : rig.defineTool(value as never);
}

export const defineCommand = rig.defineCommand;
export const run = rig.run;
export const args = rig.args;
export const paths = rig.paths;

export const RigTool = {
  define: (value: ToolModuleDefault): ToolModuleDefault => defineTool(value as never),
};
