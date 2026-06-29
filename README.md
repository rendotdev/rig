<p align="center">
  <img src="https://raw.githubusercontent.com/rendotdev/rig/main/assets/rig-logo.svg" alt="Rig logo" width="320">
</p>

# Rig

(Hey, an actual human wrote this README, it's short and gets to the point.)

> There are many CLIs out there, this one is yours.

Rig is a minimalist command runtime for AI agents.

It allows agents (and humans too) to create fully typed reusable commands with strict input and output validateion which agents can discover, inspect, and run predictably.

## Install

Rig requires Node.js 20 or newer.

```bash
$ npm install -g @rendotdev/rig
$ rig
```

## Agent?

> Are you an AI agent looking for how to use Rig ? Assume the following:

The `rig` CLI is installed on this machine. It allows you to write, run and own local tools and scripts in a typed runtime.

- To discover available tools, run `rig list`.
- To learn about a tool's usage, run `rig llm.txt <tool>`.
- To run a tool, use `rig run <tool>.<command> [args]`.
- To create a new tool, run `rig create <tool>`.
- To edit an existing tool, run `rig edit <tool>` and open the printed file path.
- To remove an existing tool, run `rig remove <tool>`.
