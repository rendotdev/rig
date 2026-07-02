<p align="center">
  <img src="https://raw.githubusercontent.com/rendotdev/rig/main/assets/rig-logo.svg" alt="rig logo" width="320">
</p>

# rig

(Hey, an actual human wrote this README. It is short and gets to the point.)

> There are many CLIs out there; this one is yours (but it's in alpha).

rig is your deterministic command runtime for AI agents.

It lets agents, and you, turn deterministic workflows into typed CLI commands. Each command has explicit input and output schemas, so agents can discover, inspect, and run tools predictably and very easily.

If you keep asking agents to repeat the same shell commands, MCP calls, browser steps, API calls, or CLI pipelines, rig creates a foundation for those workflows that you can continue to iterate on over time as things change.

rig also considers your tools context. So, every time rig runs, it keeps `AGENTS.md` and `CLAUDE.md` files updated with your current list of commands, so agents always know the tools they can use during sessions.

If you are not sure why you would want rig, here are some of my personal use cases:

- Monitor PR status in a loop.
- Pull data from the Jira, Slack, and GitHub CLIs, then feed it to an LLM to summarize my latest work for standup.
- Generate polished HTML docs using my employer's colors with Tailwind Typography from a Markdown string, convert them to a clean PDF, and drop the PDF in my Downloads folder.

_-> I'll keep adding more of my tools as I keep automating my workflows..._

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

Review the conversations available to you from the history of the last two weeks. Look for deterministic, repeatable workflows that could be automated as rig tools, especially workflows that involve shell commands, local files, browser steps, MCPs, API calls, or CLI pipelines.

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

When rig runs, it keeps detected `AGENTS.md` and `CLAUDE.md` files updated with these instructions and the current `rig list` output.

## Feedback?

Simply [send me a message](https://x.com/rendotdev) on X (formerly Twitter). I read all messages and respond to as many as I can.
