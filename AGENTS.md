# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

<!-- rig:agent-instructions:start -->

## Rig local tools

The `rig` CLI is installed on this machine. It lets agents discover, run, and create local typed tools.

- Run `rig` (or `rig init`) to set up or sync rig. This also updates detected AGENTS.md and CLAUDE.md files with available rig tools.
- Run `rig create <tool>` when the user asks you to turn a repeatable workflow into a reusable tool.
- Run `rig edit <tool>` to print the tool file path for editing.
- Run `rig remove <tool>` to remove a local tool.
- Run `rig cron --help` to schedule and manage tool commands.
- Run `rig typecheck <tool>` to validate a tool's TypeScript and runtime types.
- Run `rig env <tool> KEY=VALUE` to configure tool secrets/settings; run `rig env <tool> remove KEY` to remove them.
- Run `rig list` to discover tools and available `rig run ...` commands.
- Run `rig help <tool>` or `rig help <tool>.<command>` for usage, inputs, and outputs.
- Run `rig run <tool>.<command> [args]` to execute a tool command.
- Run `rig --help` for other Rig CLI commands.

### Available Rig tools

```text
No Rig tools found.
```

<!-- rig:agent-instructions:end -->
