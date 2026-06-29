<p align="center">
  <img src="assets/rig-logo.svg" alt="Rig logo" width="320">
</p>

# Rig

Rig is a local typed command runtime for agents.

It lets users and terminal-based agents create, discover, inspect, and run local TypeScript tools. A tool contains one or more commands. Each command declares input and output schemas, examples, and side effect level.

Command run output always has top-level `data` and `errors`. If `errors` is empty, the command succeeded and `data` is filled. If `errors` is not empty, the command failed.

## Quickstart

```bash
bun install
bun run src/cli.ts
bun run src/cli.ts tool create my-tool
bun run src/cli.ts tool help my-tool
bun run src/cli.ts run my-tool example test
```

## Model

- Tool: a local TypeScript module, for example `my-tool` or `github`.
- Command: a runnable action inside a tool, for example `example` or `list-prs`.
- Command id: `<tool>.<command>`, for example `my-tool.example`.
- Run syntax: `rig run <tool> <command> [args...]`.
- Args can be positional (`rig run my-tool example test`), key-value pairs (`rig run my-tool example text=test`), or a JSON object (`rig run my-tool example '{"text":"test"}'`).
- Success data path: `data`.
- Error details path: `errors[0]`.
- Success means `errors.length === 0`.

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
rig dev link
rig dev unlink
rig dev status
rig list
rig list --plain
rig tool create <tool>
rig tool help <tool>
rig tool help <tool> <command>
rig tool inspect <tool>
rig tool inspect <tool> <command>
rig run <tool> <command> [args...]
rig help
```

## Run output

A successful command run prints JSON like this:

```json
{
  "data": {
    "text": "test"
  },
  "errors": []
}
```

An error returns `data: null` and a non-empty `errors` array.

## Development

```bash
bun run dev
bun run test
bun run build
```

`bun run test` runs Oxfmt format checks, Oxlint lint checks, and Vitest unit tests.

Rig uses Vitest for unit tests, Oxfmt for formatting, and Oxlint for JavaScript and TypeScript linting. If formatting needs to be written, run `bunx oxfmt .` directly.

For local CLI testing, link this checkout as `rig`:

```bash
bun run src/cli.ts dev link
rig dev status
```

This writes a small shim to `~/.local/bin/rig` that runs `src/cli.ts` with Bun. Remove it with `rig dev unlink`.

## Tool files

Generated tools create one file by default:

```txt
~/.rig/tools/my-tool/tool.ts
```

Examples live inside the tool definition, not in separate README or input files. `rig tool help` renders command inputs, outputs, and examples from the definition. `rig tool inspect` includes full JSON Schema metadata.

## Limitations

Rig v1 is policy guarded, not a hard sandbox. It validates schemas, produces JSON envelopes, uses safer shell helpers, and blocks declared risky side effects unless allowed. Arbitrary TypeScript still runs locally on the user's machine.
