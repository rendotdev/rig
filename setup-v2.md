# Rig v1 build brief

Rig is a local typed command runtime for agents. It is not an agent harness, not a chat app, and not an MCP server by default. It gives users and terminal-based agents a safe, predictable way to create, discover, inspect, and run small TypeScript tools on the user's machine.

## Product promise

A user can install Rig, run one command, and let an agent use local tool commands with typed inputs, validated outputs, deterministic JSON, and clear side effect boundaries.

Rig should feel like a public, guarded version of a personal `rp`-style toolbelt:

- easy global install;
- simple first-run setup;
- local tools in visible folders;
- each tool contains one or more commands;
- each command has typed input and output schemas;
- examples live inside the tool definition;
- help output explains the command API in plain text for humans and agents;
- JSON-only stdout for command runs;
- stderr for logs and human-readable diagnostics;
- explicit side effect labels;
- policy prompts for risky actions;
- no remote services in v1;
- no MCP implementation in v1.

## Core model

Rig has tools. Tools have commands.

A tool is a local TypeScript module that groups related commands. A command is the runnable unit.

Examples:

| Tool     | Command       | Fully qualified id   | Run syntax                   |
| -------- | ------------- | -------------------- | ---------------------------- |
| `hello`  | `greet`       | `hello.greet`        | `rig run hello greet`        |
| `github` | `list-prs`    | `github.list-prs`    | `rig run github list-prs`    |
| `files`  | `search`      | `files.search`       | `rig run files search`       |
| `notion` | `create-page` | `notion.create-page` | `rig run notion create-page` |

Use the fully qualified id in lists, logs, envelopes, and agent-facing help. Use separate `<tool> <command>` arguments in the CLI so names are easier to read and validate.

## Non-goals for v1

- Do not build an agent harness.
- Do not build a GUI app.
- Do not build a hosted marketplace.
- Do not build a database-backed plugin system.
- Do not claim hard sandboxing.
- Do not require MCP.
- Do not execute raw shell strings.
- Do not create README files or example input files for generated tools by default.

## Install and first-run experience

The command name is always:

```bash
rig
```

The package name can be decided later. A likely install command is:

```bash
npm install -g @rig/cli
```

First run:

```bash
rig
```

Expected behavior:

1. Create `~/.rig` if missing.
2. Create `~/.rig/rig.json` if missing.
3. Create `~/.rig/tools` if missing.
4. Create runtime support files only if needed.
5. Print concise help.
6. Print config path.
7. Print base registry path.
8. Print discovered tool count.
9. Suggest the next command.

Default config:

```json
{
  "version": 1,
  "baseRegistryDir": "~/.rig/tools",
  "customRegistries": []
}
```

Use `~/.rig/tools`, not `~./rig/tools`.

## Core user flow

### 1. Install

```bash
npm install -g @rig/cli
```

If global install uses a temporary JavaScript shim in v1, document that compiled binaries are still the production target.

### 2. Initialize

```bash
rig init
```

This is idempotent. Running `rig` with no args should also initialize if needed.

### 3. Create a starter tool

```bash
rig tool create hello
```

Creates:

```txt
~/.rig/tools/hello/
  tool.ts
```

Do not create `README.md` or `examples/input.json` by default. The generated `tool.ts` contains the tool description, command descriptions, schemas, and examples.

Never overwrite an existing tool.

### 4. Discover tools and commands

```bash
rig tools list
rig tools list --plain
```

JSON output includes tool names, command names, fully qualified command ids, registry paths, and tool paths.

### 5. Read help before running

Tool help:

```bash
rig tool help hello
```

This prints Markdown or plain text that lists:

- the tool name;
- the tool description;
- all commands;
- each command description;
- each command side effect level;
- each command input summary;
- each command output summary;
- examples from the tool definition.

Command help:

```bash
rig tool help hello greet
```

This prints the API for one command:

- fully qualified command id;
- description;
- side effect level;
- input schema;
- output schema;
- examples in plain text;
- suggested run commands.

### 6. Inspect as JSON

```bash
rig tool inspect hello
rig tool inspect hello greet
```

`inspect` is the machine-readable version of `help`. It prints JSON for agents that prefer structured metadata.

### 7. Run a command

```bash
rig run hello greet --input '{"name":"René-Pier"}'
```

or:

```bash
rig run hello greet --input-file ./input.json
```

stdout must be deterministic JSON only.

Command run output is GraphQL-inspired. Top-level keys are always `data`, `errors`, and `extensions`.

Success response:

```json
{
  "data": {
    "hello": {
      "greet": {
        "message": "Hello, René-Pier!"
      }
    }
  },
  "errors": [],
  "extensions": {
    "rig": {
      "ok": true,
      "tool": "hello",
      "command": "greet",
      "id": "hello.greet",
      "path": ["hello", "greet"],
      "warnings": [],
      "elapsedMs": 12
    }
  }
}
```

Error response:

```json
{
  "data": null,
  "errors": [
    {
      "message": "Invalid input.",
      "path": ["hello", "greet"],
      "extensions": {
        "code": "VALIDATION_ERROR",
        "details": {}
      }
    }
  ],
  "extensions": {
    "rig": {
      "ok": false,
      "tool": "hello",
      "command": "greet",
      "id": "hello.greet",
      "path": ["hello", "greet"],
      "warnings": [],
      "elapsedMs": 3
    }
  }
}
```

## Command surface

Required commands:

```bash
rig
rig init
rig doctor
rig config show
rig config path
rig registry list
rig registry add <path>
rig registry remove <path>
rig tools list
rig tools list --plain
rig tool create <tool>
rig tool help <tool>
rig tool help <tool> <command>
rig tool inspect <tool>
rig tool inspect <tool> <command>
rig run <tool> <command> --input '<json>'
rig run <tool> <command> --input-file ./input.json
rig help-agent
```

`rig doctor` is recommended for v1 because it gives first-time users and agents a clear confidence check.

## Config behavior

Implement config helpers that can:

1. Find the user home directory.
2. Accept a home override for tests.
3. Resolve `~` paths.
4. Ensure `~/.rig` exists.
5. Ensure `~/.rig/rig.json` exists.
6. Validate config with Zod.
7. Create missing directories.
8. Read and write config safely.
9. Preserve readable `~` paths when possible.

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
- invalid config must produce a readable error.

## Registries

Rig has one base registry and zero or more custom registries.

Base registry:

```txt
~/.rig/tools
```

Custom registries are configured in `customRegistries`:

```json
{
  "customRegistries": ["~/github/myrepo/rig-tools", "~/work/company-agent-tools"]
}
```

Registry search order:

1. base registry;
2. custom registries in config order.

Tool names must be unique across registries. If two registries contain the same tool name, Rig must stop and report a duplicate tool error with both conflicting paths.

Tool folder convention:

```txt
<registry>/<tool-name>/tool.ts
```

Example:

```txt
~/.rig/tools/github/tool.ts
```

The folder name is the tool name by default.

## Tool and command naming

Tool names should be short lowercase slugs:

```txt
hello
github
files
notion
image
```

Command names should be lowercase slugs, usually verbs or verb phrases:

```txt
greet
list-prs
search
create-page
resize
```

The display id is:

```txt
<tool>.<command>
```

Examples:

```txt
hello.greet
github.list-prs
files.search
notion.create-page
image.resize
```

## Tool definition format

A generated tool should be a single `tool.ts` file. It should include all documentation needed for help output.

Preferred generated tool shape:

```ts
import { RigTool, z } from "../../runtime/sdk";

export default RigTool.define({
  name: "hello",
  description: "A starter tool that demonstrates Rig commands.",
  commands: {
    greet: {
      description: "Return a friendly greeting.",
      input: z.object({
        name: z.string().default("world"),
      }),
      output: z.object({
        message: z.string(),
      }),
      sideEffects: "read",
      examples: [
        {
          title: "Greet the world",
          text: "Use this to verify Rig can run a local command.",
          input: { name: "world" },
          output: { message: "Hello, world!" },
        },
        {
          title: "Greet a person",
          text: "Use this when the caller provides a name.",
          input: { name: "René-Pier" },
          output: { message: "Hello, René-Pier!" },
        },
      ],
      run: async ({ input }) => {
        return {
          message: `Hello, ${input.name}!`,
        };
      },
    },
  },
});
```

Use `RigTool.define()` for generated tools. Avoid floating helper functions and fragile relative imports. If a helper is required, use a stable runtime support path.

## Help output from definitions

`rig tool help <tool>` reads the tool definition and prints agent-friendly plain text or Markdown.

Example:

````txt
# hello.greet

Return a friendly greeting.

Tool: hello
Command: greet
Side effects: read

API:

```graphql
# Rig command id: hello.greet
type Query {
  hello_greet(input: HelloGreetInput): HelloGreetPayload! @sideEffects(level: READ)
}

input HelloGreetInput {
  name: String = "world"
}

type HelloGreetPayload {
  message: String!
}
```

Examples:

1. Greet the world
Use this to verify Rig can run a local command.
Input: {"name":"world"}
Output: {"message":"Hello, world!"}

Run:
rig run hello greet --input '{"name":"world"}'
````

`rig tool help <tool> <command>` prints the same information for one command, with more detail if available.

`rig tool inspect <tool>` and `rig tool inspect <tool> <command>` print JSON metadata for machine use. Inspect output includes JSON Schema and the GraphQL-inspired API block.

## SDK types

```ts
export type SideEffectLevel = "read" | "write" | "network" | "shell" | "destructive";

export type ToolExample<Input, Output> = {
  title: string;
  text: string;
  input?: Input;
  output?: Output;
};

export type CommandDefinition<Input, Output> = {
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  sideEffects: SideEffectLevel;
  examples?: ToolExample<Input, Output>[];
  run: (ctx: ToolRunContext<Input>) => Promise<Output> | Output;
};

export type ToolDefinition<Commands extends Record<string, CommandDefinition<any, any>>> = {
  name: string;
  description: string;
  commands: Commands;
};

export type ToolRunContext<Input> = {
  input: Input;
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: RigShell;
};

export type RigShell = {
  exec(args: string[], options?: ShellOptions): Promise<ShellResult>;
  json(args: string[], options?: ShellOptions): Promise<unknown>;
};
```

## Guardrails

Rig v1 is policy guarded, not a hard sandbox. Document this clearly.

Required v1 guardrails:

- every command declares a side effect level;
- inputs are validated before execution;
- outputs are validated after execution;
- stdout is reserved for JSON envelopes during command runs;
- stderr is used for logs and human-readable diagnostics;
- shell execution uses arrays only, never raw command strings;
- shell helper has timeout support;
- shell helper captures stdout, stderr, and exit code;
- destructive commands require explicit allowance;
- non-interactive execution returns structured policy errors instead of prompting silently.

Side effect levels:

| Level         | Meaning                                      | Default v1 behavior                    |
| ------------- | -------------------------------------------- | -------------------------------------- |
| `read`        | Reads local data only                        | allowed by default                     |
| `network`     | Uses network access                          | prompt or require explicit flag        |
| `write`       | Writes files or changes local state          | prompt or require explicit flag        |
| `shell`       | Runs subprocesses                            | prompt or require explicit flag        |
| `destructive` | Deletes data or performs high-risk mutations | require explicit destructive allowance |

Suggested policy error response:

```json
{
  "data": null,
  "errors": [
    {
      "message": "This command declares shell side effects and requires confirmation.",
      "path": ["deploy", "ship"],
      "extensions": {
        "code": "POLICY_CONFIRMATION_REQUIRED",
        "details": {
          "sideEffects": "shell",
          "suggestedCommand": "rig run deploy ship --input-file ./input.json --allow-shell"
        }
      }
    }
  ],
  "extensions": {
    "rig": {
      "ok": false,
      "tool": "deploy",
      "command": "ship",
      "id": "deploy.ship",
      "path": ["deploy", "ship"],
      "warnings": [],
      "elapsedMs": 1
    }
  }
}
```

## Code architecture

Use classes and service objects for application code. Avoid floating helper functions in core paths. Prefer small classes with focused methods, for example `RigConfigStore`, `ToolDiscoveryService`, `ToolLoader`, `ToolRunner`, `PolicyChecker`, and `EnvelopeFactory`.

## Runtime design

Preferred design:

1. The main `rig` binary handles CLI parsing, config, registry discovery, duplicate detection, policy checks, and orchestration.
2. Command execution happens in a runner process.
3. The runner loads the selected `tool.ts` with Bun.
4. The runner selects the requested command.
5. The runner validates input.
6. The runner executes the command.
7. The runner validates output.
8. The runner prints the JSON envelope.
9. The main process forwards stdout and stderr and exits with the runner exit code.

Development flow:

```bash
bun run src/cli.ts run hello greet --input '{}'
```

Production target:

```bash
bun build ./src/cli.ts --compile --outfile dist/rig
./dist/rig run hello greet --input '{}'
```

Include a smoke test proving the compiled `dist/rig` can run a generated TypeScript tool command.

## Project structure

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
      help.ts
      inspect.ts
      run.ts
      sdk.ts
      types.ts
    runtime/
      runner.ts
      envelope.ts
      shell.ts
      policy.ts
    commands/
      init.ts
      config.ts
      registry.ts
      tools.ts
      tool.ts
      doctor.ts
      help-agent.ts
    errors/
      RigError.ts
      codes.ts
  scripts/
    smoke.ts
  tests/
    config.test.ts
    registry.test.ts
    tool-create.test.ts
    tool-help.test.ts
    tool-run.test.ts
  examples/
    tools/
      hello/
        tool.ts
```

Adjust as needed, but keep concerns separated.

## Package scripts

```json
{
  "scripts": {
    "dev": "bun run src/cli.ts",
    "build": "bun build ./src/cli.ts --compile --outfile dist/rig",
    "test": "oxfmt . --check && oxlint . --deny-warnings && vitest run"
  },
  "bin": {
    "rig": "./dist/rig"
  }
}
```

## Tests

Use temporary directories. Do not write to the real user home directory during tests.

Required tests:

1. `~` path expansion.
2. first-run config creation.
3. config validation.
4. registry add and remove.
5. registry discovery.
6. duplicate tool detection.
7. tool creation creates only `tool.ts` by default.
8. tool help lists commands, schemas, and examples from the tool definition.
9. tool inspect prints JSON metadata.
10. command run with valid input.
11. command run with invalid input.
12. output validation failure.
13. GraphQL-inspired response shape includes `data`, `errors`, `extensions.rig.tool`, `extensions.rig.command`, and `extensions.rig.id`.
14. policy error for restricted side effects.
15. shell helper rejects raw strings at the type or runtime boundary.
16. compiled binary smoke test.

## README requirements

Explain:

- what Rig is;
- what problem it solves;
- the tool plus command model;
- install options;
- dev run;
- binary build;
- first-run config;
- where tools live;
- how to create a tool;
- how examples live in the tool definition;
- how to read tool and command help;
- how to inspect metadata as JSON;
- how to run a command;
- how to add custom registries;
- how agents should use `rig help-agent`;
- current limitations, especially policy guarding versus hard sandboxing.

Tone: practical, concise, and transparent.

## Testing, linting, and formatting

Use Vitest as the unit test runner. Use Oxlint as the project linter. Use Oxfmt as the project formatter.

Keep the package script surface minimal for now: `dev`, `test`, and `build` only. The `test` script must run format checks, lint checks, and unit tests. Commit `vitest.config.ts`, `.oxlintrc.json`, and `.oxfmtrc.json` so local runs, CI, editors, and agents share the same settings.

## Quality bar

A user should be able to run:

```bash
bun install
bun run src/cli.ts init
bun run src/cli.ts tool create hello
bun run src/cli.ts tools list
bun run src/cli.ts tool help hello
bun run src/cli.ts tool help hello greet
bun run src/cli.ts tool inspect hello greet
bun run src/cli.ts run hello greet --input '{"name":"René-Pier"}'
bun run test
bun run build
./dist/rig run hello greet --input '{"name":"René-Pier"}'
```

The run command must output valid JSON.

Do not leave major TODOs in config, discovery, tool creation, help generation, inspection, command execution, validation, envelopes, or compiled smoke paths.
