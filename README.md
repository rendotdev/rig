<p align="center">
  <img src="https://raw.githubusercontent.com/rendotdev/rig/main/assets/rig-logo.svg" alt="Rig logo" width="320">
</p>

# Rig

Rig is a local command runtime for AI agents.

It exposes TypeScript files on the user's machine as discoverable commands. Each command has typed input, typed output, examples, and a run function. Every run returns a JSON envelope with `data` and `errors`, so agents can inspect, execute, and recover predictably.

## Install

Rig requires Node.js 20 or newer.

```bash
npm install -g @rendotdev/rig
```

Initialize the local Rig environment:

```bash
rig
```

## Agent command map

Use these commands when operating Rig for a user.

### Want to discover available commands?

```bash
rig list --plain
rig list
```

Use `rig list --plain` when you need a compact list of command ids. Use `rig list` when you need JSON metadata.

### Want to understand a tool or command?

```bash
rig help <tool>
rig help <tool> <command>
rig inspect <tool>
rig inspect <tool> <command>
```

Use `rig help` for human-readable docs. Use `rig inspect` for machine-readable schemas, examples, and run syntax.

### Want to run a command?

```bash
rig run <tool> <command> [args...]
rig run <tool> <command> key=value
rig run <tool> <command> --input '{"key":"value"}'
rig run <tool> <command> --input-file input.json
```

Parse stdout as JSON. Success is `errors: []` with the result in `data`. Failure is `data: null` with the first error in `errors[0]`.

### Want to validate before running?

```bash
rig run <tool> <command> --dry-run [args...]
```

Use `--dry-run` to validate input and see the command line before execution.

### Want to create a new tool or command?

```bash
rig tool create <tool>
```

Then edit:

```txt
~/.rig/tools/<tool>/index.rig.ts
```

After editing, run:

```bash
rig typecheck <tool>
rig help <tool>
rig inspect <tool>
```

Generated tools use `rig.command(...)`, `rig.input(...)`, and `rig.output(...)`. Keep examples inside the tool definition so agents can inspect them.

### Want to type-check tools?

```bash
rig typecheck
rig typecheck <tool>
```

Run this after creating or editing tools.

### Want to inspect or fix local setup?

```bash
rig init
rig doctor
rig config show
rig config path
```

### Want to manage tool registries?

```bash
rig registry list
rig registry add <path>
rig registry remove <path>
```

Use registries to make additional local tool directories discoverable.

### Want agent instructions?

```bash
rig llm.txt
```

Add the output to an agent prompt or memory file.

## Agent rules

- Inspect a command before running it when the command is unfamiliar.
- Prefer `rig help <tool> <command>` for readable docs.
- Prefer `rig inspect <tool> <command>` when you need schemas or examples.
- Use `--dry-run` when you want to validate input without executing the command.
- Parse stdout as JSON.
- Treat stderr as logs or diagnostics.
- Use `data` on success and `errors[0]` on failure.
- If output is truncated, read the JSON file at `data.fullOutputPath`.

## Files Rig creates

```txt
~/.rig/rig.json
~/.rig/tools
~/.rig/runtime/sdk.ts
~/.rig/runtime/types.d.ts
~/.rig/runtime/globals.d.ts
```

Default config:

```json
{
  "version": 1,
  "baseRegistryDir": "~/.rig/tools",
  "customRegistries": []
}
```

## Command output contract

Success:

```json
{
  "data": {},
  "errors": []
}
```

Failure:

```json
{
  "data": null,
  "errors": [
    {
      "code": "VALIDATION_ERROR",
      "message": "Invalid input.",
      "details": {}
    }
  ]
}
```

Large successful outputs are truncated to 50KB or 2000 lines. Rig saves the full JSON output to a temp file and returns the path in `data.fullOutputPath`.

## Tool authoring notes

- Tool files export a Rig tool factory.
- Commands live in the tool definition.
- Inputs must use `rig.input(...)`.
- Outputs must use `rig.output(...)`.
- Examples should live in the command definition.
- Run `rig typecheck <tool>` after edits.

## Develop Rig from source

```bash
bun install
bun run dev
bun run test
bun run build
```

For local CLI testing:

```bash
bun run src/cli.ts dev link
rig dev status
rig dev unlink
```

## Limits

Rig validates schemas and returns consistent JSON envelopes. Tools are local TypeScript code, so run tools the user trusts.
