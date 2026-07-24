import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { defineSingleton } from "../../define";
import type { CollectionDefinition, CollectionHandle } from "../collection";
import { CommandTargetSingleton } from "../identifiers";

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

export type RigCacheKey = readonly unknown[];

export type RigCacheQueryOptions<T> = {
  queryKey: RigCacheKey;
  queryFn: () => MaybePromise<T>;
  /** Cached values younger than this duration return immediately; missing or stale values refresh before returning. */
  staleTime?: number;
};

export type RigToolCache = {
  readonly path: string;
  query<T>(options: RigCacheQueryOptions<T>): Promise<T>;
  peek<T = unknown>(queryKey: RigCacheKey): T | undefined;
  set<T>(queryKey: RigCacheKey, value: T): void;
  invalidate(queryKey: RigCacheKey): void;
  remove(queryKey: RigCacheKey): void;
  clear(): void;
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

export type ToolRunContext<Input, Env = unknown, Collections = Record<string, CollectionHandle>> = {
  input: Input;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
  db: RigToolDatabase;
  kv: RigToolKvStore;
  cache: RigToolCache;
  log: RigToolLogger;
  rig: RigToolKit;
  collections: Collections;
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
  Collections = Record<string, CollectionHandle>,
> = {
  description: string;
  input: Input;
  output: Output;
  examples?: ToolExample<z.input<Input>, z.output<Output>>[];
  run: (ctx: ToolRunContext<z.output<Input>, Env, Collections>) => MaybePromise<z.input<Output>>;
};

export type ToolCollectionDefinitions = Record<string, CollectionDefinition>;

export type ToolCollectionHandles<Collections extends ToolCollectionDefinitions> = {
  [Name in keyof Collections]: Collections[Name] extends CollectionDefinition<infer Schema>
    ? CollectionHandle<z.output<Schema>>
    : CollectionHandle;
};

export type ToolCommandBuilder<Env, Collections> = <
  Input extends RigSchema,
  Output extends RigSchema,
>(
  definition: CommandDefinition<Input, Output, Env, Collections>,
) => CommandDefinition<Input, Output, Env, Collections>;

export type ToolCommandMap = Record<string, CommandDefinition<any, any, any, any>>;

export type ToolCommandsFactory<Env, Collections, Commands extends ToolCommandMap> = (
  command: ToolCommandBuilder<Env, Collections>,
) => Commands;

export type ToolDefinitionInput<
  Env extends RigSchema = RigSchema,
  Collections extends ToolCollectionDefinitions = ToolCollectionDefinitions,
  Commands extends ToolCommandMap = ToolCommandMap,
> = {
  name?: string;
  description: string;
  env?: Env;
  setupDb?: (db: RigToolDatabase) => MaybePromise<void>;
  collections?: Collections;
  commands:
    | Commands
    | ToolCommandsFactory<z.output<Env>, ToolCollectionHandles<Collections>, Commands>;
};

export type NormalizedToolDefinitionInput<
  Env extends RigSchema = RigSchema,
  Collections extends ToolCollectionDefinitions = ToolCollectionDefinitions,
  Commands extends ToolCommandMap = ToolCommandMap,
> = Omit<ToolDefinitionInput<Env, Collections, Commands>, "commands"> & {
  commands: Commands;
};

export type ToolDefinition = {
  name: string;
  description: string;
  env?: RigSchema;
  setupDb?: (db: RigToolDatabase) => MaybePromise<void>;
  collections?: ToolCollectionDefinitions;
  commands: Record<string, CommandDefinition>;
};

export type ToolFactory = (
  rig: RigToolKit,
) => ToolDefinitionInput<any, any, any> | Promise<ToolDefinitionInput<any, any, any>>;
export type ToolModuleDefault = ToolDefinitionInput | ToolDefinition | ToolFactory;

export type RigToolKit = {
  z: typeof z;
  defineTool<
    Env extends RigSchema = RigSchema,
    Collections extends ToolCollectionDefinitions = ToolCollectionDefinitions,
    const Commands extends ToolCommandMap = ToolCommandMap,
  >(
    definition: ToolDefinitionInput<Env, Collections, Commands>,
  ): NormalizedToolDefinitionInput<Env, Collections, Commands>;
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

export const CommandIdsSingleton = defineSingleton({
  params: {},
  deps: { CommandTargetSingleton },
  from(params: { tool: string; command: string }) {
    return this.deps.CommandTargetSingleton.from(params).id;
  },
});

export type CommandIdsClass = {
  from(tool: string, command: string): string;
};

type CommandIdsConstructor = {
  new (): CommandIdsClass;
  readonly prototype: CommandIdsClass;
};

export const CommandIdsClass = function () {} as unknown as CommandIdsConstructor;

Object.defineProperty(CommandIdsClass.prototype, "from", {
  configurable: true,
  value: function from(tool: string, command: string) {
    return CommandIdsSingleton.from({ tool, command });
  },
  writable: true,
});

export const commandIds = new CommandIdsClass();
