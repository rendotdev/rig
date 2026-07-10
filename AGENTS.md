# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

<!-- rig:agent-instructions:start -->

## Rig local tools

The `rig` CLI is installed on this machine. It is _your_ CLI. You own its various tools and commands. Use it to create, edit, and run tools when you need repeatable and deterministic workflows.

- Run `rig` (or `rig init`) to set up or sync rig. This also updates detected AGENTS.md and CLAUDE.md files with available rig tools.
- Run `rig create <tool>` when the user asks you to turn a repeatable workflow into a reusable tool.
- Run `rig edit <tool>` to print the tool file path for editing.
- Run `rig remove <tool>` to remove a local tool.
- Run `rig cron --help` to schedule and manage tool commands.
- Run `rig typecheck <tool>` to validate a tool's TypeScript and runtime types.
- Run `rig env <tool> KEY=VALUE` to configure tool secrets/settings; run `rig env <tool> remove KEY` to remove them.
- Run `rig list` to discover tools and available `rig run ...` commands.
- Run `rig help <topic>` for concept docs (collections, cache, kv, db, env, log, shell, run, tool, args, paths).
- Run `rig help <tool>` or `rig help <tool>.<command>` for usage, inputs, and outputs.
- Run `rig run <tool>.<command> [args]` to execute a tool command.
- To chain commands, use `--as <id>`, `--pipe`, and `@id.path` references to pass structured outputs instead of guessing filenames.
- To learn more, run `rig --help` for other Rig CLI commands.

### Learn more

- Run `rig help collections` to learn about tool content collections (schema-validated markdown document stores with FTS search).
- Run `rig help tool` to learn how to create a new rig tool from scratch.
- Run `rig help kv` to learn about lightweight key-value state.
- Run `rig help cache` to learn about persistent stale-while-revalidate query data.
- Run `rig help db` to learn about raw SQLite databases with migrations.
- Run `rig help topics` to see all available help topics.

### Available Rig tools

```text
No Rig tools found.
```

<!-- rig:agent-instructions:end -->
