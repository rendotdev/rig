import { existsSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type ConfigOptions } from "../config/config";
import { RigPaths } from "../config/paths";
import { ToolListService } from "../tools/list";
import { RigAgentInstructions } from "./instructions";

export type AgentInstructionSyncOptions = ConfigOptions & {
  cwd?: string;
};

export type AgentInstructionTarget = {
  path: string;
  existed: boolean;
  scope: "all" | "visible";
};

export type AgentInstructionUpdate = AgentInstructionTarget & {
  changed: boolean;
};

export type AgentInstructionSyncResult = {
  skipped: boolean;
  targets: AgentInstructionUpdate[];
};

const StartMarker = "<!-- rig:agent-instructions:start -->";
const EndMarker = "<!-- rig:agent-instructions:end -->";

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

export class AgentInstructionSyncService {
  private readonly cwd: string;
  private readonly paths: RigPaths;
  private readonly listService: ToolListService;

  constructor(options: AgentInstructionSyncOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.paths = new RigPaths(options);
    this.listService = new ToolListService(options);
  }

  async sync(): Promise<AgentInstructionSyncResult> {
    if (process.env.RIG_AGENT_SYNC === "0") return { skipped: true, targets: [] };

    const targets = await this.discoverTargets();
    if (targets.length === 0) return { skipped: false, targets: [] };

    const updates = await Promise.all(
      targets.map(async (target) => {
        const block = this.renderBlock(await this.renderToolList(target));
        return {
          ...target,
          changed: await this.upsertManagedBlock(target, block),
        };
      }),
    );

    return { skipped: false, targets: updates };
  }

  async discoverTargets(): Promise<AgentInstructionTarget[]> {
    const targets = new Map<string, AgentInstructionTarget>();

    await Promise.all(
      this.projectDirectories().flatMap((directory) => [
        ...AgentInstructionSyncLocations.projectFiles.map((file) =>
          this.addExistingFile(targets, join(directory, file), "visible"),
        ),
        ...AgentInstructionSyncLocations.projectClaudeDirectories.map((directoryName) =>
          this.addClaudeDirectoryTarget(targets, join(directory, directoryName), "visible"),
        ),
      ]),
    );

    await Promise.all([
      ...AgentInstructionSyncLocations.homeClaudeDirectories.map((path) =>
        this.addClaudeDirectoryTarget(targets, join(this.paths.homeDir, ...path), "all"),
      ),
      ...AgentInstructionSyncLocations.homeFiles.map((path) =>
        this.addExistingFile(targets, join(this.paths.homeDir, ...path), "all"),
      ),
      this.addOpenCodeInstructionTargets(targets),
    ]);

    return [...targets.values()].toSorted((left, right) => left.path.localeCompare(right.path));
  }

  renderBlock(toolList: string): string {
    return `${StartMarker}
## Rig local tools

${RigAgentInstructions}
### Available Rig tools

\`\`\`text
${toolList}
\`\`\`
${EndMarker}`;
  }

  private async renderToolList(target: AgentInstructionTarget): Promise<string> {
    const options = target.scope === "visible" ? { visibleFromPath: target.path } : {};
    return this.listService.renderPlain(await this.listService.list(options));
  }

  private async addExistingFile(
    targets: Map<string, AgentInstructionTarget>,
    path: string,
    scope: AgentInstructionTarget["scope"],
  ): Promise<void> {
    if (await this.isFile(path)) await this.setTarget(targets, path, true, scope);
  }

  private async addClaudeDirectoryTarget(
    targets: Map<string, AgentInstructionTarget>,
    directory: string,
    scope: AgentInstructionTarget["scope"],
  ): Promise<void> {
    const path = join(directory, "CLAUDE.md");
    const fileExists = await this.isFile(path);
    const directoryExists = fileExists ? false : await this.isDirectory(directory);
    if (fileExists || directoryExists) await this.setTarget(targets, path, fileExists, scope);
  }

  private async addOpenCodeInstructionTargets(
    targets: Map<string, AgentInstructionTarget>,
  ): Promise<void> {
    await Promise.all(
      AgentInstructionSyncLocations.openCodeConfigFiles.map((path) =>
        this.addOpenCodeConfigTargets(targets, join(this.paths.homeDir, ...path)),
      ),
    );
  }

  private async addOpenCodeConfigTargets(
    targets: Map<string, AgentInstructionTarget>,
    configPath: string,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!this.isRecord(parsed) || !Array.isArray(parsed.instructions)) return;

    await Promise.all(
      parsed.instructions.map((instruction) => {
        if (typeof instruction !== "string") return Promise.resolve();
        const instructionPath = this.resolveOpenCodeInstructionPath(
          instruction,
          dirname(configPath),
        );
        return this.addExistingFile(
          targets,
          instructionPath,
          this.instructionScope(instructionPath),
        );
      }),
    );
  }

  private resolveOpenCodeInstructionPath(path: string, configDir: string): string {
    if (path === "~" || path.startsWith("~/")) return this.paths.resolve(path);
    return isAbsolute(path) ? path : resolve(configDir, path);
  }

  private instructionScope(path: string): AgentInstructionTarget["scope"] {
    let current = dirname(path);
    const home = resolve(this.paths.homeDir);

    while (true) {
      if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json"))) {
        return "visible";
      }

      if (current === home) return "all";
      const parent = dirname(current);
      if (parent === current) return "visible";
      current = parent;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private async setTarget(
    targets: Map<string, AgentInstructionTarget>,
    path: string,
    existed: boolean,
    scope: AgentInstructionTarget["scope"],
  ): Promise<void> {
    const key = existed ? await this.realPath(path) : path;
    const current = targets.get(key);
    const nextScope = current?.scope === "visible" || scope === "visible" ? "visible" : "all";
    if (!current || path < current.path) targets.set(key, { path, existed, scope: nextScope });
    else current.scope = nextScope;
  }

  private async upsertManagedBlock(
    target: AgentInstructionTarget,
    block: string,
  ): Promise<boolean> {
    const existing = target.existed ? await readFile(target.path, "utf8") : "";
    const nextBody = this.managedBlockPattern().test(existing)
      ? existing.replace(this.managedBlockPattern(), block)
      : this.appendBlock(existing, block);
    const next = `${nextBody.trimEnd()}\n`;

    if (next === existing) return false;

    await writeFile(target.path, next, "utf8");
    return true;
  }

  private appendBlock(existing: string, block: string): string {
    return [existing.trimEnd(), block].filter(Boolean).join("\n\n");
  }

  private managedBlockPattern(): RegExp {
    return new RegExp(`${this.escapeRegExp(StartMarker)}[\\s\\S]*?${this.escapeRegExp(EndMarker)}`);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async realPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  private projectDirectories(): string[] {
    const root = this.projectRoot();
    const directories: string[] = [];
    let current = this.cwd;

    while (true) {
      directories.push(current);
      if (current === root) return directories;
      current = dirname(current);
    }
  }

  private projectRoot(): string {
    const start = this.cwd;
    let current = start;
    let packageRoot: string | undefined;

    while (true) {
      if (this.isGitRoot(current)) return current;
      if (!packageRoot && this.isPackageRoot(current)) packageRoot = current;

      const parent = dirname(current);
      if (parent === current) return packageRoot ?? start;

      current = parent;
    }
  }

  private isGitRoot(directory: string): boolean {
    return existsSync(join(directory, ".git"));
  }

  private isPackageRoot(directory: string): boolean {
    return existsSync(join(directory, "package.json"));
  }
}
