import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import type { SuccessEnvelope } from "../../runtime/envelope";
import { BunRigShellClass } from "../../runtime/shell";
import { commandTargets } from "../identifiers";
import {
  type CommandDefinition,
  type RigArgBuilder,
  type RigPathHelper,
  type RigRunOptions,
  type RigSchema,
  type RigToolKit,
  type ToolDefinition,
  type ToolFactory,
  type ToolModuleDefault,
} from "../types";

export { z };

class RigPathRuntimeClass implements RigPathHelper {
  home(): string {
    return homedir();
  }

  resolve(cwd: string, pathValue: string): string {
    if (pathValue === "~") return homedir();
    if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
    return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
  }

  async ensureParent(pathValue: string): Promise<void> {
    await mkdir(dirname(pathValue), { recursive: true });
  }

  size(pathValue: string): number {
    return existsSync(pathValue) ? statSync(pathValue).size : 0;
  }
}

class RigArgsRuntimeClass implements RigArgBuilder {
  private readonly args: string[] = [];

  raw(...values: string[]): RigArgBuilder {
    this.args.push(...values);
    return this;
  }

  flag(name: string, enabled = true): RigArgBuilder {
    if (enabled) this.args.push(name);
    return this;
  }

  value(name: string, value: string | number | boolean | undefined | null): RigArgBuilder {
    if (value !== undefined && value !== null) this.args.push(name, String(value));
    return this;
  }

  values(name: string, values: string[] | undefined): RigArgBuilder {
    for (const value of values ?? []) this.args.push(name, value);
    return this;
  }

  toArray(): string[] {
    return [...this.args];
  }
}

type RigToolKitFactoryOptions = ConfigOptions;

export type RigCommandRunnerDependencies = {
  run(
    tool: string,
    command: string,
    options: ConfigOptions & { args?: string[]; input?: string; dryRun?: boolean },
  ): Promise<{ envelope: unknown; exitCode: number }>;
};

class RigCommandRunnerRuntimeClass {
  constructor(
    private readonly options: RigToolKitFactoryOptions = {},
    private readonly dependencies?: RigCommandRunnerDependencies,
  ) {}

  async run<T = unknown>(options: RigRunOptions): Promise<T> {
    const target = this.commandTarget(options);
    const runner = this.dependencies ?? (await this.defaultRunner());
    const result = await runner.run(target.tool, target.command, {
      ...this.options,
      args: options.args,
      input: options.input === undefined ? undefined : JSON.stringify(options.input),
      dryRun: options.dryRun,
    });

    if (result.exitCode === 0) return (result.envelope as SuccessEnvelope).data as T;

    throw new RigErrorClass("TOOL_RUN_ERROR", `Rig tool command failed: ${target.id}`, {
      command: target.id,
      envelope: result.envelope,
    });
  }

  private async defaultRunner(): Promise<RigCommandRunnerDependencies> {
    const { ToolRunnerClass } = await import("../run");
    return new ToolRunnerClass(this.options);
  }

  private commandTarget(options: RigRunOptions): { tool: string; command: string; id: string } {
    return options.tool
      ? commandTargets.parse(`${options.tool}.${options.command}`)
      : commandTargets.parse(options.command);
  }
}

class RigToolKitFactoryClass {
  constructor(
    private readonly options: RigToolKitFactoryOptions = {},
    private readonly dependencies?: RigCommandRunnerDependencies,
  ) {}

  create(): RigToolKit {
    const shell = new BunRigShellClass();
    return {
      z,
      defineTool: <T extends ToolDefinition>(definition: T) => definition,
      defineCommand: <I extends RigSchema, O extends RigSchema>(
        definition: CommandDefinition<I, O>,
      ) => definition,
      run: <T = unknown>(options: RigRunOptions) =>
        new RigCommandRunnerRuntimeClass(this.options, this.dependencies).run<T>(options),
      $: (strings: TemplateStringsArray, ...values: unknown[]) => shell.$(strings, ...values),
      args: () => new RigArgsRuntimeClass(),
      paths: new RigPathRuntimeClass(),
      shell,
    } as RigToolKit;
  }
}

export const rig = new RigToolKitFactoryClass().create();

export function defineTool(definition: ToolDefinition): ToolDefinition;
export function defineTool(factory: ToolFactory): ToolFactory;
export function defineTool(value: ToolModuleDefault): ToolModuleDefault {
  return typeof value === "function" ? value : rig.defineTool(value);
}

export const defineCommand = rig.defineCommand;
export const run = rig.run;
export const args = rig.args;
export const paths = rig.paths;

export class RigToolClass {
  define(value: ToolDefinition): ToolDefinition;
  define(value: ToolFactory): ToolFactory;
  define(value: ToolModuleDefault): ToolModuleDefault {
    return defineTool(value as never);
  }
}

export const RigTool = new RigToolClass();

export function createRigToolKit(
  options: RigToolKitFactoryOptions = {},
  dependencies?: RigCommandRunnerDependencies,
): RigToolKit {
  return new RigToolKitFactoryClass(options, dependencies).create();
}
