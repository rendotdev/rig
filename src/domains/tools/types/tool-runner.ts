export type RunCommandOptions = Readonly<{
  homeDir?: string;
  input?: string;
  inputFile?: string;
  args?: string[];
  dryRun?: boolean;
  pipeContext?: Record<string, unknown>;
}>;

export type RunCommandResult = Readonly<{
  envelope: unknown;
  exitCode: number;
}>;
