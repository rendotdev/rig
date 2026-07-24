import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineRuntime, defineService, defineSingleton } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import type { SuccessEnvelope } from "../../runtime/envelope";
import { BunRigShellClass } from "../../runtime/shell";
import { commandTargets } from "../identifiers";
import {
  type CommandDefinition,
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
} from "../types";

export { z };

const RigPathRuntimeProductionDeps = {
  homedir,
  exists: existsSync,
  stat: statSync,
  mkdir,
  dirname,
  isAbsolute,
  join,
  resolve,
};

export class RigPathRuntimeService extends defineRuntime({
  params: {},
  deps: RigPathRuntimeProductionDeps,
}) {
  public home(_params: {}): string {
    return this.deps.homedir();
  }

  public resolve(params: { cwd: string; pathValue: string }): string {
    if (params.pathValue === "~") return this.deps.homedir();
    if (params.pathValue.startsWith("~/")) {
      return this.deps.join(this.deps.homedir(), params.pathValue.slice(2));
    }
    return this.deps.isAbsolute(params.pathValue)
      ? params.pathValue
      : this.deps.resolve(params.cwd, params.pathValue);
  }

  public async ensureParent(params: { pathValue: string }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(params.pathValue), { recursive: true });
  }

  public size(params: { pathValue: string }): number {
    return this.deps.exists(params.pathValue) ? this.deps.stat(params.pathValue).size : 0;
  }
}

export const RigPathRuntime = new RigPathRuntimeService();

function createRigPathHelper(service: RigPathRuntimeService = RigPathRuntime): RigPathHelper {
  return {
    home() {
      return service.home({});
    },
    resolve(cwd, pathValue) {
      return service.resolve({ cwd, pathValue });
    },
    async ensureParent(pathValue) {
      await service.ensureParent({ pathValue });
    },
    size(pathValue) {
      return service.size({ pathValue });
    },
  };
}

function createRigArgBuilder(_params: {}): RigArgBuilder {
  const values: string[] = [];
  const builder: RigArgBuilder = {
    raw(...items: string[]) {
      values.push(...items);
      return builder;
    },
    flag(name: string, enabled = true) {
      if (enabled) values.push(name);
      return builder;
    },
    value(name: string, value: string | number | boolean | undefined | null) {
      if (value !== undefined && value !== null) values.push(name, String(value));
      return builder;
    },
    values(name: string, items: string[] | undefined) {
      for (const value of items ?? []) values.push(name, value);
      return builder;
    },
    toArray() {
      return [...values];
    },
  };
  return builder;
}

export const RigArgsRuntimeSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createRigArgBuilder,
});

type RigToolKitFactoryOptions = ConfigOptions;

export type RigCommandRunnerDependencies = {
  run(
    tool: string,
    command: string,
    options: ConfigOptions & { args?: string[]; input?: string; dryRun?: boolean },
  ): Promise<{ envelope: unknown; exitCode: number }>;
};

type RigCommandRunnerDeps = {
  runner?: RigCommandRunnerDependencies;
  createDefaultRunner: (options: RigToolKitFactoryOptions) => Promise<RigCommandRunnerDependencies>;
};

const RigCommandRunnerProductionDeps: RigCommandRunnerDeps = {
  async createDefaultRunner(options) {
    const toolRunnerModule = await import("../run");
    return new toolRunnerModule.ToolRunnerClass(options);
  },
};

function commandTarget(params: { options: RigRunOptions }): {
  tool: string;
  command: string;
  id: string;
} {
  return params.options.tool
    ? commandTargets.parse(`${params.options.tool}.${params.options.command}`)
    : commandTargets.parse(params.options.command);
}

export class RigCommandRunnerService extends defineService({
  params: {} as RigToolKitFactoryOptions,
  deps: RigCommandRunnerProductionDeps,
}) {
  public async run<T = unknown>(params: { options: RigRunOptions }): Promise<T> {
    const target = commandTarget(params);
    const runner = this.deps.runner ?? (await this.deps.createDefaultRunner(this.params));
    const result = await runner.run(target.tool, target.command, {
      ...this.params,
      args: params.options.args,
      input: params.options.input === undefined ? undefined : JSON.stringify(params.options.input),
      dryRun: params.options.dryRun,
    });

    if (result.exitCode === 0) return (result.envelope as SuccessEnvelope).data as T;
    throw new RigErrorClass("TOOL_RUN_ERROR", `Rig tool command failed: ${target.id}`, {
      command: target.id,
      envelope: result.envelope,
    });
  }
}

export const RigCommandRunner = new RigCommandRunnerService();

type RigToolKitFactoryDeps = {
  runner?: RigCommandRunnerDependencies;
  createDefaultRunner: RigCommandRunnerDeps["createDefaultRunner"];
  createShell: () => BunRigShellClass;
  createPaths: () => RigPathHelper;
  createArgs: () => RigArgBuilder;
};

const RigToolKitFactoryProductionDeps: RigToolKitFactoryDeps = {
  createDefaultRunner: RigCommandRunnerProductionDeps.createDefaultRunner,
  createShell() {
    return new BunRigShellClass();
  },
  createPaths: createRigPathHelper,
  createArgs() {
    return RigArgsRuntimeSingleton.create({});
  },
};

export class RigToolKitFactoryService extends defineService({
  params: {} as RigToolKitFactoryOptions,
  deps: RigToolKitFactoryProductionDeps,
}) {
  public create(_params: {}): RigToolKit {
    const shell = this.deps.createShell();
    const commandRunner = new RigCommandRunnerService({
      params: this.params,
      deps: {
        runner: this.deps.runner,
        createDefaultRunner: this.deps.createDefaultRunner,
      },
    });
    return {
      z,
      defineTool: <
        Env extends RigSchema = RigSchema,
        Collections extends ToolCollectionDefinitions = ToolCollectionDefinitions,
        const Commands extends ToolCommandMap = ToolCommandMap,
      >(
        definition: ToolDefinitionInput<Env, Collections, Commands>,
      ) =>
        typeof definition.commands === "function"
          ? { ...definition, commands: definition.commands((command) => command) }
          : definition,
      defineCommand: <I extends RigSchema, O extends RigSchema>(
        definition: CommandDefinition<I, O>,
      ) => definition,
      run: <T = unknown>(options: RigRunOptions) => commandRunner.run<T>({ options }),
      $: (strings: TemplateStringsArray, ...values: unknown[]) => shell.$(strings, ...values),
      args: this.deps.createArgs,
      paths: this.deps.createPaths(),
      shell,
    } as RigToolKit;
  }
}

export const RigToolKitFactory = new RigToolKitFactoryService();

export const rig = RigToolKitFactory.create({});

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

function defineRigTool(params: { value: ToolModuleDefault }): ToolModuleDefault {
  return defineTool(params.value as never);
}

export const RigToolSingleton = defineSingleton({
  params: {},
  deps: {},
  define: defineRigTool,
});

export type RigToolClass = {
  define(value: ToolDefinitionInput): ToolDefinitionInput;
  define(value: ToolFactory): ToolFactory;
};

type RigToolConstructor = {
  new (): RigToolClass;
  readonly prototype: RigToolClass;
};

const RigToolClassAdapter = function constructRigTool(): void {};
Object.defineProperty(RigToolClassAdapter, "name", { value: "RigToolClass" });
Object.defineProperty(RigToolClassAdapter.prototype, "define", {
  configurable: true,
  value: function define(value: ToolModuleDefault) {
    return RigToolSingleton.define({ value });
  },
  writable: true,
});

export const RigToolClass = RigToolClassAdapter as unknown as RigToolConstructor;
export const RigTool = new RigToolClass();

export function createRigToolKit(
  options: RigToolKitFactoryOptions = {},
  dependencies?: RigCommandRunnerDependencies,
): RigToolKit {
  return new RigToolKitFactoryService({
    params: options,
    deps: { ...RigToolKitFactoryProductionDeps, runner: dependencies },
  }).create({});
}
