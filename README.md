# Rig

Rig is a local typed command runtime for agents.

It lets users and terminal-based agents create, discover, inspect, and run local TypeScript tools. A tool contains one or more commands. Each command declares input and output schemas, examples, and side effect level.

Command run output is GraphQL-inspired: top-level `data`, `errors`, and `extensions`.

## Quickstart

```bash
bun install
bun run src/cli.ts
bun run src/cli.ts tool create hello
bun run src/cli.ts tool help hello
bun run src/cli.ts run hello greet --input '{"name":"world"}'
```

## Model

- Tool: a local TypeScript module, for example `hello` or `github`.
- Command: a runnable action inside a tool, for example `greet` or `list-prs`.
- Command id: `<tool>.<command>`, for example `hello.greet`.
- Run syntax: `rig run <tool> <command> --input '<json>'`.
- Success data path: `data.<tool>.<command>`.
- Error details path: `errors[0].extensions`.
- Rig metadata path: `extensions.rig`.

## Config

First run creates:

```txt
~/.rig/rig.json
~/.rig/tools
~/.rig/runtime/sdk.ts
```

Default config:

```json
{
  "version": 1,
  "baseRegistryDir": "~/.rig/tools",
  "customRegistries": []
}
```

## Commands

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
rig help-agent
```

## Run output

A successful command run prints JSON like this:

```json
{
  "data": {
    "hello": {
      "greet": {
        "message": "Hello, world!"
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
      "elapsedMs": 8
    }
  }
}
```

An error returns `data: null`, a GraphQL-style `errors` array, and Rig metadata in `extensions.rig`.

## Development

```bash
bun run dev
bun run test
bun run build
```

`bun run test` runs Oxfmt format checks, Oxlint lint checks, and Vitest unit tests.

Rig uses Vitest for unit tests, Oxfmt for formatting, and Oxlint for JavaScript and TypeScript linting. If formatting needs to be written, run `bunx oxfmt .` directly.

## Tool files

Generated tools create one file by default:

```txt
~/.rig/tools/hello/tool.ts
```

Examples live inside the tool definition, not in separate README or input files. `rig tool help` renders a GraphQL-inspired command API from the definition. `rig tool inspect` includes full JSON Schema metadata.

## Limitations

Rig v1 is policy guarded, not a hard sandbox. It validates schemas, produces JSON envelopes, uses safer shell helpers, and blocks declared risky side effects unless allowed. Arbitrary TypeScript still runs locally on the user's machine.
