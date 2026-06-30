# AGENTS.md

- Never commit or push unless asked for.
- For custom code we write, prefer self-contained domain classes over floating functions.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` and `Bun.write(...)` for file I/O instead of `node:fs/promises` `readFile` or `writeFile`.
- Keep the text of `./src/agents/instructions.ts` and the text below `> Are you an AI agent looking for how to use rig? Assume the following:` in the README.md sync.