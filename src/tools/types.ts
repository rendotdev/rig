import type { z } from "zod";

export type SideEffectLevel = "read" | "write" | "network" | "shell" | "destructive";

export const SideEffectLevels: SideEffectLevel[] = [
  "read",
  "write",
  "network",
  "shell",
  "destructive",
];

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
  exec(args: string[], options?: ShellOptions): Promise<ShellResult>;
  json(args: string[], options?: ShellOptions): Promise<unknown>;
};

export type ToolRunContext<Input> = {
  input: Input;
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: RigShell;
};

export type ToolExample<Input = any, Output = any> = {
  title: string;
  text: string;
  input?: Input;
  output?: Output;
};

export type CommandDefinition<Input = any, Output = any> = {
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  sideEffects: SideEffectLevel;
  examples?: ToolExample<Input, Output>[];
  run: (ctx: ToolRunContext<Input>) => Promise<Output> | Output;
};

export type ToolDefinition = {
  name: string;
  description: string;
  commands: Record<string, CommandDefinition>;
};

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
