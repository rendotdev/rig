import type { z } from "zod";

export const RigSchemaRoleSymbol = Symbol.for("rig.schemaRole");
export type RigSchemaRole = "input" | "output";
export declare const RigInputSchemaBrand: unique symbol;
export declare const RigOutputSchemaBrand: unique symbol;

export type RigInputSchema<T extends z.ZodTypeAny = z.ZodTypeAny> = T & {
  readonly [RigInputSchemaBrand]: T;
  readonly [RigSchemaRoleSymbol]?: "input";
};

export type RigOutputSchema<T extends z.ZodTypeAny = z.ZodTypeAny> = T & {
  readonly [RigOutputSchemaBrand]: T;
  readonly [RigSchemaRoleSymbol]?: "output";
};

export type RigSchema<T = any> = RigInputSchema<z.ZodType<T>> | RigOutputSchema<z.ZodType<T>>;
export type AnyRigInputSchema = RigInputSchema<z.ZodTypeAny>;
export type AnyRigOutputSchema = RigOutputSchema<z.ZodTypeAny>;
export type RigInputData<T extends AnyRigInputSchema> = z.output<T>;
export type RigOutputData<T extends AnyRigOutputSchema> = z.output<T>;
export type RigOutputCandidate<T extends AnyRigOutputSchema> = z.input<T>;
export type MaybePromise<T> = T | Promise<T>;

export type ShellOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ShellResult = {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RigShell = {
  $(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;
  exec(args: string[], options?: ShellOptions): Promise<ShellResult>;
  bash(command: string, options?: ShellOptions): Promise<ShellResult>;
  json(args: string[], options?: ShellOptions): Promise<unknown>;
};

export type RigPathHelper = {
  home(): string;
  resolve(cwd: string, pathValue: string): string;
  ensureParent(pathValue: string): Promise<void>;
  size(pathValue: string): number;
};

export type RigArgBuilder = {
  raw(...values: string[]): RigArgBuilder;
  flag(name: string, enabled?: boolean): RigArgBuilder;
  value(name: string, value: string | number | boolean | undefined | null): RigArgBuilder;
  values(name: string, values: string[] | undefined): RigArgBuilder;
  toArray(): string[];
};

export type SchemaFromValue<T extends z.ZodTypeAny | z.ZodRawShape> = T extends z.ZodTypeAny
  ? T
  : T extends z.ZodRawShape
    ? z.ZodObject<T>
    : never;

export type RigRunOptions = {
  tool?: string;
  command: string;
  input?: unknown;
  args?: string[];
  dryRun?: boolean;
};

export type RigToolKit = {
  z: typeof z;
  defineTool<T extends ToolDefinition>(definition: T): T;
  command<I extends AnyRigInputSchema, O extends AnyRigOutputSchema>(
    definition: CommandDefinition<I, O>,
  ): CommandDefinition<I, O>;
  input<T extends z.ZodTypeAny | z.ZodRawShape>(value: T): RigInputSchema<SchemaFromValue<T>>;
  output<T extends z.ZodTypeAny | z.ZodRawShape>(value: T): RigOutputSchema<SchemaFromValue<T>>;
  run<T = unknown>(options: RigRunOptions): Promise<T>;
  $(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;
  args(): RigArgBuilder;
  paths: RigPathHelper;
  shell: RigShell;
};

export type ToolRunContext<Input> = {
  input: Input;
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: RigShell;
  rig: RigToolKit;
};

export type ToolExample<Input = any, Output = any> = {
  title: string;
  text: string;
  input?: Input;
  output?: Output;
};

export type CommandDefinition<
  Input extends AnyRigInputSchema = AnyRigInputSchema,
  Output extends AnyRigOutputSchema = AnyRigOutputSchema,
> = {
  description: string;
  input: Input;
  output: Output;
  examples?: ToolExample<z.input<Input>, z.output<Output>>[];
  run: (ctx: ToolRunContext<z.output<Input>>) => MaybePromise<z.input<Output>>;
};

export type ToolDefinition = {
  name: string;
  description: string;
  commands: Record<string, CommandDefinition>;
};

export type ToolFactory = (rig: RigToolKit) => ToolDefinition | Promise<ToolDefinition>;
export type ToolModuleDefault = ToolDefinition | ToolFactory;

export type LoadedTool = {
  name: string;
  path: string;
  definition: ToolDefinition;
};

export class CommandIds {
  static from(tool: string, command: string): string {
    return `${tool}.${command}`;
  }
}
