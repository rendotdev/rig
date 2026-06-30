import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import type { SuccessEnvelope } from "../runtime/envelope";
import { BunRigShell } from "../runtime/shell";
import {
  CommandIds,
  type CommandDefinition,
  type RigArgBuilder,
  type RigPathHelper,
  type RigRunOptions,
  type RigSchema,
  type RigToolKit,
  type ToolDefinition,
  type ToolFactory,
  type ToolModuleDefault,
} from "./types";

export { z };

class RigPathRuntime implements RigPathHelper {
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

class RigArgsRuntime implements RigArgBuilder {
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

class RigCommandRunnerRuntime {
  constructor(private readonly options: RigToolKitFactoryOptions = {}) {}

  async run<T = unknown>(options: RigRunOptions): Promise<T> {
    const target = this.commandTarget(options);
    const { ToolRunner } = await import("./run");
    const result = await new ToolRunner(this.options).run(target.tool, target.command, {
      ...this.options,
      args: options.args,
      input: options.input === undefined ? undefined : JSON.stringify(options.input),
      dryRun: options.dryRun,
    });

    if (result.exitCode === 0) return (result.envelope as SuccessEnvelope).data as T;

    throw new RigError("TOOL_RUN_ERROR", `Rig tool command failed: ${target.id}`, {
      command: target.id,
      envelope: result.envelope,
    });
  }

  private commandTarget(options: RigRunOptions): { tool: string; command: string; id: string } {
    const id = options.tool ? CommandIds.from(options.tool, options.command) : options.command;
    const parts = id.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new RigError("INPUT_ERROR", `Command id must use <tool>.<command>: ${id}`);
    }
    return { tool: parts[0], command: parts[1], id };
  }
}

class RigToolKitFactory {
  constructor(private readonly options: RigToolKitFactoryOptions = {}) {}

  create(): RigToolKit {
    const shell = new BunRigShell();
    return {
      z,
      defineTool: <T extends ToolDefinition>(definition: T) => definition,
      defineCommand: <I extends RigSchema, O extends RigSchema>(
        definition: CommandDefinition<I, O>,
      ) => definition,
      run: <T = unknown>(options: RigRunOptions) =>
        new RigCommandRunnerRuntime(this.options).run<T>(options),
      $: (strings: TemplateStringsArray, ...values: unknown[]) => shell.$(strings, ...values),
      args: () => new RigArgsRuntime(),
      paths: new RigPathRuntime(),
      shell,
    } as RigToolKit;
  }
}

export const rig = new RigToolKitFactory().create();

export function defineTool(definition: ToolDefinition): ToolDefinition;
export function defineTool(factory: ToolFactory): ToolFactory;
export function defineTool(value: ToolModuleDefault): ToolModuleDefault {
  return typeof value === "function" ? value : rig.defineTool(value);
}

export const defineCommand = rig.defineCommand;
export const run = rig.run;
export const args = rig.args;
export const paths = rig.paths;

export class RigTool {
  static define(value: ToolDefinition): ToolDefinition;
  static define(value: ToolFactory): ToolFactory;
  static define(value: ToolModuleDefault): ToolModuleDefault {
    return defineTool(value as never);
  }
}

export function createRigToolKit(options: RigToolKitFactoryOptions = {}): RigToolKit {
  return new RigToolKitFactory(options).create();
}
