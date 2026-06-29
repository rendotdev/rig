import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  RigSchemaRoleSymbol,
  type AnyRigInputSchema,
  type AnyRigOutputSchema,
  type CommandDefinition,
  type RigArgBuilder,
  type RigInputSchema,
  type RigOutputSchema,
  type RigPathHelper,
  type RigSchema,
  type RigSchemaRole,
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

class RigToolKitFactory {
  create(): RigToolKit {
    return {
      z,
      defineTool: <T extends ToolDefinition>(definition: T) => definition,
      command: <Input extends AnyRigInputSchema, Output extends AnyRigOutputSchema>(
        definition: CommandDefinition<Input, Output>,
      ) => definition,
      input: (value: z.ZodTypeAny | z.ZodRawShape) => this.schema(value, "input"),
      output: (value: z.ZodTypeAny | z.ZodRawShape) => this.schema(value, "output"),
      args: () => new RigArgsRuntime(),
      paths: new RigPathRuntime(),
    } as RigToolKit;
  }

  private schema(value: z.ZodTypeAny | z.ZodRawShape, role: "input"): RigInputSchema;
  private schema(value: z.ZodTypeAny | z.ZodRawShape, role: "output"): RigOutputSchema;
  private schema(value: z.ZodTypeAny | z.ZodRawShape, role: RigSchemaRole): RigSchema {
    const schema = this.isZodSchema(value) ? value : z.object(value as z.ZodRawShape);
    const existingRole = (schema as unknown as Record<symbol, unknown>)[RigSchemaRoleSymbol];
    if (existingRole === role) return schema as RigSchema;
    Object.defineProperty(schema, RigSchemaRoleSymbol, {
      value: role,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return schema as RigSchema;
  }

  private isZodSchema(value: unknown): value is z.ZodTypeAny {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { safeParse?: unknown }).safeParse === "function"
    );
  }
}

export const rig = new RigToolKitFactory().create();

export function defineTool(definition: ToolDefinition): ToolDefinition;
export function defineTool(factory: ToolFactory): ToolFactory;
export function defineTool(value: ToolModuleDefault): ToolModuleDefault {
  return typeof value === "function" ? value : rig.defineTool(value);
}

export const command = rig.command;
export const input = rig.input;
export const output = rig.output;
export const args = rig.args;
export const paths = rig.paths;

export class RigTool {
  static define(value: ToolDefinition): ToolDefinition;
  static define(value: ToolFactory): ToolFactory;
  static define(value: ToolModuleDefault): ToolModuleDefault {
    return defineTool(value as never);
  }
}

export function createRigToolKit(): RigToolKit {
  return new RigToolKitFactory().create();
}
