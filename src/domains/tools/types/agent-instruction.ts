export type AgentInstructionTarget = {
  path: string;
  existed: boolean;
  scope: "all" | "visible";
};

type AgentInstructionUpdate = AgentInstructionTarget & {
  changed: boolean;
};

export type AgentInstructionSyncResult = {
  skipped: boolean;
  targets: AgentInstructionUpdate[];
};

export const AgentInstructionStartMarker = "<!-- rig:agent-instructions:start -->";
export const AgentInstructionEndMarker = "<!-- rig:agent-instructions:end -->";
export const AgentInstructionIgnoreMarker = "<!-- rig:ignore -->";

export const AgentInstructionSyncLocations = {
  projectFiles: ["AGENTS.md", "CLAUDE.md"],
  projectClaudeDirectories: [".claude"],
  homeFiles: [
    [".agents", "AGENTS.md"],
    [".pi", "agent", "AGENTS.md"],
  ],
  homeClaudeDirectories: [[".claude"]],
  openCodeConfigFiles: [
    [".config", "opencode", "opencode.json"],
    [".opencode", "opencode.json"],
  ],
} as const;
