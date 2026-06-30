import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

    const block = this.renderBlock(await this.renderToolList());
    const updates = await Promise.all(
      targets.map(async (target) => ({
        ...target,
        changed: await this.upsertManagedBlock(target, block),
      })),
    );

    return { skipped: false, targets: updates };
  }

  async discoverTargets(): Promise<AgentInstructionTarget[]> {
    const targets = new Map<string, AgentInstructionTarget>();

    await Promise.all(
      this.projectDirectories().flatMap((directory) => [
        this.addExistingFile(targets, join(directory, "AGENTS.md")),
        this.addExistingFile(targets, join(directory, "CLAUDE.md")),
        this.addClaudeDirectoryTarget(targets, join(directory, ".claude")),
      ]),
    );

    await this.addClaudeDirectoryTarget(targets, join(this.paths.homeDir, ".claude"));

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

  private async renderToolList(): Promise<string> {
    return this.listService.renderPlain(await this.listService.list());
  }

  private async addExistingFile(
    targets: Map<string, AgentInstructionTarget>,
    path: string,
  ): Promise<void> {
    if (await this.isFile(path)) targets.set(path, { path, existed: true });
  }

  private async addClaudeDirectoryTarget(
    targets: Map<string, AgentInstructionTarget>,
    directory: string,
  ): Promise<void> {
    const path = join(directory, "CLAUDE.md");
    const fileExists = await this.isFile(path);
    const directoryExists = fileExists ? false : await this.isDirectory(directory);
    if (fileExists || directoryExists) targets.set(path, { path, existed: fileExists });
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
