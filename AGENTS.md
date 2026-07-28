# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

## Effect reference

- Run `vp run effect:reference` when `repos/effect/LLMS.md` is missing before writing Effect code.
- Read `repos/effect/LLMS.md`, then use `repos/effect` as read-only reference material.
- Import Effect from package dependencies; never import application code from `repos/effect`.
