// Keep in sync with README.md "Agent?" section
export const RigAgentInstructions = `The \`rig\` CLI is installed on this machine. It allows you to write, run and own local tools and scripts in a typed runtime.

- To sync all tools to AGENTS.md and CLAUDE.md, run \`rig\` (or \`rig init\`).
- To discover available tools, run \`rig list\`.
- To learn about a tool's usage, run \`rig help <tool>\`.
- To run a tool, use \`rig run <tool>.<command> [args]\`.
- Tools run under Bun with fallback auto-install enabled, so tool files can import npm packages; add explicit package versions when reproducibility matters.
- To schedule a tool command, use \`rig cron add <name> <tool>.<command> <schedule> --input '<json>'\`; use \`rig cron list\`, \`rig cron run <name>\`, and \`rig cron remove <name>\` to manage scheduled runs.
- If a tool needs local secrets or settings, put them in the tool folder's \`.env\`, add an \`env\` Zod schema to the tool definition, and read validated values from \`context.env\`.
- To create a new tool, run \`rig create <tool>\`.
- To edit an existing tool, run \`rig edit <tool>\` and open the printed file path.
- To remove an existing tool, run \`rig remove <tool>\`.
- To list tool registries, run \`rig registry list\`.
- To add a registry, run \`rig registry create [path]\` (defaults to current directory).
- If a tool needs persistent state, define \`setupDb\` and use \`context.db\`; Rig stores that SQLite database beside the tool entry file as \`index.sqlite\`.
`;
