You are building a new open-source TypeScript/Bun CLI project called **Rig**.

Rig is a local typed tool runtime for agents. It is not an agent harness and not an MCP server by default. It is a companion tool for agent harnesses like Pi, Claude Code, Codex, Goose, or any terminal-based agent. The goal is to make it easy for users and agents to create small, project-specific tools written in TypeScript, with typed inputs, validated outputs, deterministic JSON, and clean shell execution.

Build the initial project from scratch.

## Core concept

Users install Rig globally with npm:

```bash
npm install -g <package-name>
```

The installed command must be:

```bash
rig
```

The npm namespace/package name can be decided later, but the CLI binary must be named `rig`.

Rig itself must be a Bun-based CLI written in TypeScript. The production binary should be built with Bun using `bun build --compile`, so it can eventually be distributed as a standalone executable.

Rig should load and run user-created custom tools written in TypeScript. These tools live in registries. A registry is just a directory containing tool folders and TypeScript files.

The first version should focus on local functionality, clean architecture, testability, and a good developer experience.

## First-run behavior

When `rig` is executed for the first time, it should create a global config directory and config file.

Config directory:

```txt
~/.rig
```

Config file:

```txt
~/.rig/rig.json
```

Default config content:

```json
{
  "version": 1,
  "baseRegistryDir": "~/.rig/tools",
  "customRegistries": []
}
```

Also create the base registry directory if it does not exist:

```txt
~/.rig/tools
```

Important correction: use `~/.rig/tools`, not `~./rig/tools`.

Paths containing `~` must be expanded to the user home directory internally, but the config file can preserve `~` for readability.

## Config behavior

Implement config helpers that can:

1. Find the user home directory.
2. Resolve `~` paths.
3. Ensure `~/.rig` exists.
4. Ensure `~/.rig/rig.json` exists.
5. Validate the config.
6. Create missing directories.
7. Read and write config safely.

Config type:

```ts
export type RigConfig = {
  version: 1;
  baseRegistryDir: string;
  customRegistries: string[];
};
```

Validation rules:

- `version` must be `1`.
- `baseRegistryDir` must be a non-empty string.
- `customRegistries` must be an array of strings.
- all registry paths must resolve to absolute paths before use.
- invalid config should produce a readable error.

Use Zod for config validation.

## Registries

Rig has one base registry and zero or more custom registries.

Base registry:

```txt
~/.rig/tools
```

Custom registries are configured in:

```json
{
  "customRegistries": ["~/github/myrepo/tools", "~/work/company-agent-tools"]
}
```

The registry search order should be:

1. base registry
2. custom registries in config order

Tool names must be unique. If the same tool name appears in multiple registries, Rig should report a clear duplicate tool error and include the conflicting paths.

Implement registry discovery with a small, explicit convention.

A tool should live in a folder like:

```txt
~/.rig/tools/github.list-prs/
  tool.ts
  README.md
  examples/
    input.json
```

The tool name is the folder name by default, for example:

```txt
github.list-prs
```

For the first version, require this structure:

```txt
<registry>/<tool-name>/tool.ts
```

## CLI commands

Use a solid CLI parser. Prefer `commander` unless there is a better Bun-friendly choice.

Implement these commands:

```bash
rig
rig init
rig config show
rig config path
rig registry list
rig registry add <path>
rig registry remove <path>
rig tools list
rig tool create <name>
rig tool inspect <name>
rig run <name> --input '<json>'
rig run <name> --input-file ./input.json
rig help-agent
```

Behavior:

### `rig`

Running `rig` with no args should:

1. Ensure config exists.
2. Print a concise help message.
3. Show config path.
4. Show base registry path.
5. Show how many tools are discovered.

### `rig init`

Creates config and base registry directory if missing.

Should be idempotent.

### `rig config show`

Prints config as JSON.

### `rig config path`

Prints the absolute path to `~/.rig/rig.json`.

### `rig registry list`

Prints all registries as JSON:

```json
{
  "baseRegistryDir": "/Users/name/.rig/tools",
  "customRegistries": ["/Users/name/github/myrepo/tools"],
  "registries": [
    {
      "kind": "base",
      "path": "/Users/name/.rig/tools"
    },
    {
      "kind": "custom",
      "path": "/Users/name/github/myrepo/tools"
    }
  ]
}
```

### `rig registry add <path>`

Adds a custom registry path to `customRegistries`.

Requirements:

- expand `~`;
- preserve path as the user wrote it if reasonable;
- create the directory if it does not exist;
- avoid duplicates after path resolution;
- write updated config.

### `rig registry remove <path>`

Removes a custom registry.

Requirements:

- compare by resolved absolute path;
- if missing, show readable error;
- write updated config.

### `rig tools list`

Discovers all tools across all registries and prints JSON:

```json
{
  "tools": [
    {
      "name": "github.list-prs",
      "registryPath": "/Users/name/.rig/tools",
      "toolPath": "/Users/name/.rig/tools/github.list-prs/tool.ts"
    }
  ]
}
```

For human readability, also support:

```bash
rig tools list --plain
```

### `rig tool create <name>`

Creates a new tool folder in the base registry.

Example:

```bash
rig tool create github.list-prs
```

Creates:

```txt
~/.rig/tools/github.list-prs/
  tool.ts
  README.md
  examples/
    input.json
```

Do not overwrite existing tools.

Generated `tool.ts` should use the local Rig SDK import convention chosen for this project.

For the first version, keep the SDK inside the package source. If runtime imports from compiled binary are awkward, create a generated local runtime SDK in `~/.rig/runtime/sdk.ts`, or use another clean approach. The important thing is that generated tools should be valid TypeScript and runnable by Rig.

Generated tool example should:

- import `z` from `zod`;
- define input schema;
- define output schema;
- export default `defineTool({...})`;
- return deterministic JSON data.

Example generated tool:

```ts
import { z } from "zod";
import { defineTool } from "../../runtime/sdk";

export default defineTool({
  name: "github.list-prs",
  description: "Describe what this tool does.",
  input: z.object({
    message: z.string().default("hello"),
  }),
  output: z.object({
    message: z.string(),
  }),
  sideEffects: "read",
  run: async ({ input }) => {
    return {
      message: input.message,
    };
  },
});
```

Adjust the import path based on the final runtime layout.

### `rig tool inspect <name>`

Loads the tool and prints a JSON description:

```json
{
  "name": "github.list-prs",
  "description": "List pull requests for a GitHub repository.",
  "sideEffects": "read",
  "inputSchema": {},
  "outputSchema": {},
  "path": "/Users/name/.rig/tools/github.list-prs/tool.ts"
}
```

Use Zod schemas and convert them to JSON Schema if practical. If JSON Schema conversion is too much for the first pass, return a clear placeholder and structure the code so JSON Schema conversion can be added soon.

### `rig run <name>`

Runs a tool by name.

Inputs:

```bash
rig run github.list-prs --input '{"message":"hello"}'
```

or:

```bash
rig run github.list-prs --input-file ./input.json
```

Output must be deterministic JSON on stdout.

Success envelope:

```json
{
  "ok": true,
  "tool": "github.list-prs",
  "data": {
    "message": "hello"
  },
  "warnings": [],
  "meta": {
    "elapsedMs": 12
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "tool": "github.list-prs",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input.",
    "details": {}
  },
  "warnings": [],
  "meta": {
    "elapsedMs": 3
  }
}
```

Important stdout/stderr rule:

- stdout is reserved for machine-readable JSON.
- stderr is for logs, debug output, and human-readable errors.

For command failures before a run command executes, still prefer JSON if the command is an execution command. For setup/config commands, readable text is fine unless `--json` is provided.

### `rig help-agent`

Prints agent-facing instructions in Markdown.

It should explain:

- Rig is a typed local tool runtime.
- Use `rig tools list` to discover tools.
- Use `rig tool inspect <name>` before running a tool.
- Use `rig run <name> --input '<json>'` to run tools.
- stdout is JSON only for run commands.
- stderr may contain logs.
- tools are local TypeScript files.
- agents may create tools with `rig tool create <name>`.
- agents should avoid destructive tools unless explicitly requested by the user.

This output is meant to be pasted into `AGENTS.md`, Pi docs, Claude Code instructions, or similar agent context files.

## Tool SDK design

Create a small SDK.

Types:

```ts
export type SideEffectLevel = "read" | "write" | "network" | "shell" | "destructive";

export type ToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  sideEffects: SideEffectLevel;
  run: (ctx: ToolRunContext<Input>) => Promise<Output> | Output;
};

export type ToolRunContext<Input> = {
  input: Input;
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: RigShell;
};

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output>;
```

Shell helper:

```ts
export type RigShell = {
  exec(args: string[], options?: ShellOptions): Promise<ShellResult>;
  json(args: string[], options?: ShellOptions): Promise<unknown>;
};
```

For the first version, implement `shell.exec` using Bun subprocess APIs if possible. It should:

- accept command and args as an array, never a raw string;
- capture stdout;
- capture stderr;
- return exit code;
- throw or return structured errors consistently.

## Runtime design

Because Rig itself will eventually be a compiled Bun executable, custom TypeScript tools should be loaded through Bun at runtime.

Preferred runtime design:

1. The main `rig` binary handles CLI parsing, config, discovery and orchestration.
2. Tool execution happens through a separate runner process.
3. The runner loads the selected `tool.ts`, validates input, executes the tool, validates output and prints the JSON envelope.
4. The main process captures stdout/stderr and exits with the same exit code.

Use Bun where available. Since the final compiled binary includes Bun, investigate and implement the cleanest approach for running TypeScript files from the compiled executable.

If needed, structure the project so local development works first with:

```bash
bun run src/cli.ts run example.tool --input '{}'
```

Then add compiled binary support:

```bash
bun build ./src/cli.ts --compile --outfile dist/rig
./dist/rig run example.tool --input '{}'
```

Important: include a smoke test or documented manual test proving that the compiled `dist/rig` can run a TypeScript tool.

## Project structure

Use a clean structure like:

```txt
rig/
  package.json
  tsconfig.json
  README.md
  src/
    cli.ts
    config/
      config.ts
      paths.ts
      schema.ts
    registry/
      discover.ts
      registry.ts
    tools/
      create.ts
      inspect.ts
      run.ts
      sdk.ts
      types.ts
    runtime/
      runner.ts
      envelope.ts
      shell.ts
    commands/
      init.ts
      config.ts
      registry.ts
      tools.ts
      tool.ts
      help-agent.ts
    errors/
      RigError.ts
      codes.ts
  tests/
    config.test.ts
    registry.test.ts
    tool-create.test.ts
    tool-run.test.ts
  examples/
    tools/
      echo/
        tool.ts
        examples/
          input.json
```

Adjust as needed, but keep separation of concerns.

## Build scripts

Package scripts should include:

```json
{
  "scripts": {
    "dev": "bun run src/cli.ts",
    "check": "tsc --noEmit",
    "test": "bun test",
    "build": "bun build ./src/cli.ts --compile --outfile dist/rig",
    "smoke": "bun run scripts/smoke.ts"
  },
  "bin": {
    "rig": "./dist/rig"
  }
}
```

If npm global install cannot use a platform-specific compiled binary in this first version, provide a temporary bin shim that runs the TypeScript or JavaScript entrypoint, but still keep the compiled binary build as the target production path.

Explain this in README.

## Requirements

Use:

- Bun
- TypeScript
- Zod
- commander or equivalent CLI parser
- Bun test

Avoid:

- unnecessary frameworks;
- remote services;
- MCP implementation in the first version;
- complex plugin systems;
- database storage;
- raw shell string execution.

## Tests

Write tests for:

1. `~` path expansion.
2. first-run config creation.
3. config validation.
4. registry add/remove.
5. registry discovery.
6. duplicate tool detection.
7. tool creation.
8. run command with valid input.
9. run command with invalid input.
10. output validation failure.
11. JSON envelope shape.

Use temporary directories for tests. Do not write to the real user home directory during tests. Config helpers should accept an override home directory for testing.

## README

Create a README that explains:

- what Rig is;
- what problem it solves;
- how to install;
- how to run in dev;
- how to build the binary;
- how first-run config works;
- where tools live;
- how to create a tool;
- how to run a tool;
- how to add custom registries;
- how agents should use `rig help-agent`;
- current limitations.

README tone should be practical and concise.

## Quality bar

The project should be usable after implementation.

A user should be able to run:

```bash
bun install
bun run src/cli.ts init
bun run src/cli.ts tool create demo.echo
bun run src/cli.ts tools list
bun run src/cli.ts tool inspect demo.echo
bun run src/cli.ts run demo.echo --input '{"message":"hello"}'
bun run build
./dist/rig run demo.echo --input '{"message":"hello"}'
```

Expected output for the run command should be valid JSON.

Do not leave major TODOs in core execution paths.

Implement the minimal working version, then document any future improvements clearly.
