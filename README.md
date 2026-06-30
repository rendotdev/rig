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

The `rig` CLI is installed on this machine. It allows you to write, run and own local tools and scripts in a typed runtime.

- To sync all tools to AGENTS.md and CLAUDE.md, run `rig` (or `rig init`).
- To discover available tools, run `rig list`.
- To learn about a tool's usage, run `rig help <tool>`.
- To run a tool, use `rig run <tool>.<command> [args]`.
- To create a new tool, run `rig create <tool>`.
- To edit an existing tool, run `rig edit <tool>` and open the printed file path.
- To remove an existing tool, run `rig remove <tool>`.
- To list tool registries, run `rig registry list`.
- To add a registry, run `rig registry create [path]` (defaults to current directory).

When rig runs, it keeps detected `AGENTS.md` and `CLAUDE.md` files updated with these instructions and the current `rig list` output.

## Feedback?

Simply [send me a message](https://x.com/rendotdev) on X (formerly Twitter). I read all messages and respond to as many as I can.
