import type { Database } from "bun:sqlite";
import type { z } from "zod";

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

export type RigRunOptions = {
  tool?: string;
  command: string;
  input?: unknown;
  args?: string[];
  dryRun?: boolean;
};

export type RigSchema = z.ZodTypeAny;

export type RigToolDatabase = Database & {
  readonly path: string;
  migrate(version: number, name: string, sql: string): void;
};

export type RigToolKvStore = {
  readonly path: string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
};

export type RigLogMethod = {
  (message: string): void;
  (bindings: Record<string, unknown>, message?: string): void;
  (error: Error, message?: string): void;
};

export type RigToolLogger = {
  trace: RigLogMethod;
  debug: RigLogMethod;
  info: RigLogMethod;
  warn: RigLogMethod;
  error: RigLogMethod;
  fatal: RigLogMethod;
  child(bindings: Record<string, unknown>): RigToolLogger;
};

export type ToolRunContext<Input, Env = unknown> = {
  input: Input;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
  db: RigToolDatabase;
  kv: RigToolKvStore;
  log: RigToolLogger;
  rig: RigToolKit;
};

export type ToolExample<Input = any, Output = any> = {
  title: string;
  text: string;
  input?: Input;
  output?: Output;
};

export type CommandDefinition<
  Input extends RigSchema = RigSchema,
  Output extends RigSchema = RigSchema,
  Env = unknown,
> = {
  description: string;
  input: Input;
  output: Output;
  examples?: ToolExample<z.input<Input>, z.output<Output>>[];
  run: (ctx: ToolRunContext<z.output<Input>, Env>) => MaybePromise<z.input<Output>>;
};

export type ToolDefinition<Env extends RigSchema = RigSchema> = {
  name: string;
  description: string;
  env?: Env;
  setupDb?: (db: RigToolDatabase) => MaybePromise<void>;
  commands: Record<string, CommandDefinition<RigSchema, RigSchema, z.output<Env>>>;
};

export type ToolFactory = (rig: RigToolKit) => ToolDefinition | Promise<ToolDefinition>;
export type ToolModuleDefault = ToolDefinition | ToolFactory;

export type RigToolKit = {
  z: typeof z;
  defineTool<T extends ToolDefinition>(definition: T): T;
  defineCommand<I extends RigSchema, O extends RigSchema>(
    definition: CommandDefinition<I, O>,
  ): CommandDefinition<I, O>;
  run<T = unknown>(options: RigRunOptions): Promise<T>;
  $(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;
  args(): RigArgBuilder;
  paths: RigPathHelper;
  shell: RigShell;
};

export type LoadedTool = {
  name: string;
  path: string;
  env: unknown;
  definition: ToolDefinition;
};

export class CommandIds {
  static from(tool: string, command: string): string {
    return `${tool}.${command}`;
  }
}
