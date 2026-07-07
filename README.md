<p align="center">
  <img src="https://raw.githubusercontent.com/rendotdev/rig/main/assets/rig-logo.svg" alt="rig logo" width="320">
</p>

# rig

(Hey, an actual human wrote this README. It is short and gets to the point.)

> There are many CLIs out there; this one is yours (but it's in alpha).

rig is _your_ deterministic CLI for _your_ AI agents.

It lets agents, and you, turn deterministic workflows into type-safe CLI commands. Each command has explicit input and output schemas, so agents can discover, inspect, and run tools predictably and easily.

If you keep asking agents to repeat the same shell commands, API or MCP calls, or browser steps, rig creates a foundation for those workflows that you can continue to build upon over time as things change.

rig also treats your tools as first-class context. Every time rig runs, it keeps `AGENTS.md` and `CLAUDE.md` files updated with your current list of commands. That way, your agents always know the tools they can use during sessions.

rig also has cool features for your tools like:

- **$ Shell**: run system commands within a tool
- **Content Collections**: schema-validated markdown document stores with fast-search
- **cron**: schedule tool commands to run on a schedule
- **.env**: manage tool secrets and settings
- **KV**: lightweight key-value storage
- **DB**: lightweight SQLite powered databases with support for migrations
- **Log**: structured tool logging
- **Chaining**: pipe structured outputs between commands

<details>
<summary>If you are not sure why you would want rig, here are some of my personal use cases:</summary>

- I have a tool that pulls data from Jira/Slack/GitHub, then feeds it to an LLM to summarize my latest work for standup.
- I have a tool that takes Markdown/HTML and generates a polished PDF with my employer's colors and typography, then drops it in my Downloads folder.
- I have a tool that manipulates images (converts, resizes, compresses, removes metadata).
- I have a tool that converts PDF to text.
- I have a tool that makes a fetch call and extracts the readable text from a web page.
- ...
  _-> I'll keep adding more of my tools as I keep automating my workflows..._

</details>

## Install

```bash
$ npm install -g @rendotdev/rig
$ rig
```

## Install prompt

Give this prompt to an agent to ask it to install rig for you:

```text

Read the README from this repo: `https://github.com/rendotdev/rig`.

Then, install rig globally with `npm install -g @rendotdev/rig`, then run `rig` to initialize it.

Review the conversations available to you from the threads of the last two weeks with the user. Look for deterministic, repeatable workflows that could be automated as rig tools, especially workflows that involve shell commands, local files, browser steps, API calls, MCPs, or CLI pipelines.

List the best candidates with this information:

**Workflow name**

- Evidence from recent conversations
- Proposed rig tool
- Inputs
- Outputs
- Why it should be automated

Do not implement anything yet. Ask the user which workflow they want to implement first.
```

## Agent?

<!-- Keep in sync with src/agents/instructions.ts -->

> Are you an AI agent looking for how to use rig? Assume the following:

The `rig` CLI is installed on this machine. It is _your_ CLI. You own its various tools and commands. Use it to create, edit, and run tools when you need repeatable and determinstic workflows.

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
- To chain commands, use `--as <id>`, `--pipe`, and `@id.path` references to pass structured outputs instead of guessing filenames.
- To learn more, run `rig --help` for other Rig CLI commands.

When rig runs, it keeps detected `AGENTS.md` and `CLAUDE.md` files updated with these instructions and the current `rig list` output.

## Feedback?

Simply [send me a message](https://x.com/rendotdev) on X (formerly Twitter). I read all messages and respond to as many as I can.
