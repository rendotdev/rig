import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RigAgentInstructions } from "../../agents/instructions";
import { type ConfigOptions } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { RigToolEntryFiles } from "../../registry/discover";
import { ToolListServiceClass } from "../../tools/list";
import { ToolApiMigrationServiceClass } from "../../tools/migration/tool-api-migration";

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
const IgnoreMarker = "<!-- rig:ignore -->";

type AgentSyncStamp = {
  sourceFingerprint: string;
  targetFingerprints: Record<string, string>;
};

/* v8 ignore start */
class AgentSyncFingerprintClass {
  constructor(private readonly params: { paths: RigPathsClass }) {}

  async source(): Promise<string | undefined> {
    try {
      const configSource = await readFile(this.params.paths.configPath, "utf8");
      const config = JSON.parse(configSource) as {
        baseRegistryDir?: string;
        customRegistries?: string[];
      };
      const registryPaths = [
        this.params.paths.resolve(
          config.baseRegistryDir || this.params.paths.defaultBaseRegistryDir,
        ),
        ...(config.customRegistries ?? []).map((path) => this.params.paths.resolve(path)),
      ];
      const sources = await Promise.all(
        registryPaths.map(async (registryPath) => {
          const entries = await this.directoryEntries(registryPath);
          return Promise.all(
            entries.flatMap((entry) =>
              RigToolEntryFiles.map(async (file) => {
                const path = join(registryPath, entry, file);
                try {
                  return `${path}\0${await readFile(path, "utf8")}`;
                } catch {
                  return undefined;
                }
              }),
            ),
          );
        }),
      );
      return this.hash([RigAgentInstructions, configSource, ...sources.flat(2).filter(Boolean)]);
    } catch {
      return undefined;
    }
  }

  async targets(targets: AgentInstructionTarget[]): Promise<Record<string, string> | undefined> {
    try {
      return Object.fromEntries(
        await Promise.all(
          targets.map(async (target) => [
            target.path,
            this.hash([await readFile(target.path, "utf8")]),
          ]),
        ),
      );
    } catch {
      return undefined;
    }
  }

  private async directoryEntries(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    } catch {
      return [];
    }
  }

  private hash(values: Array<string | undefined>): string {
    const hash = createHash("sha256");
    for (const value of values) hash.update(value ?? "").update("\0");
    return hash.digest("hex");
  }
}
/* v8 ignore stop */

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

export class AgentInstructionSyncServiceClass {
  private readonly cwd: string;
  private readonly paths: RigPathsClass;
  private readonly listService: ToolListServiceClass;
  private readonly migrationService: ToolApiMigrationServiceClass;
  private readonly fingerprint: AgentSyncFingerprintClass;

  constructor(options: AgentInstructionSyncOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.paths = new RigPathsClass(options);
    this.listService = new ToolListServiceClass(options);
    this.migrationService = new ToolApiMigrationServiceClass(options, {});
    this.fingerprint = new AgentSyncFingerprintClass({ paths: this.paths });
  }

  async sync(): Promise<AgentInstructionSyncResult> {
    if (process.env.RIG_AGENT_SYNC === "0") return { skipped: true, targets: [] };

    const targets = await this.discoverTargets();
    if (targets.length === 0) return { skipped: false, targets: [] };

    /* v8 ignore next 5 */
    if (await this.canSkipSync(targets)) {
      return {
        skipped: false,
        targets: targets.map((target) => ({ ...target, changed: false })),
      };
    }

    const migrationInstructions = this.migrationService.renderAgentInstructions({
      report: await this.migrationService.inspect(),
    });
    const updates = await Promise.all(
      targets.map(async (target) => {
        /* v8 ignore next 3 */
        if (target.scope === "visible" && !(await this.projectHasRegistry())) {
          return { ...target, changed: await this.removeManagedBlock(target) };
        }
        const block = this.renderBlock(await this.renderToolList(target), migrationInstructions);
        return {
          ...target,
          changed: await this.upsertManagedBlock(target, block),
        };
      }),
    );

    await this.writeSyncStamp(targets);
    return { skipped: false, targets: updates };
  }

  private get syncStampPath(): string {
    return join(this.paths.rigDir, ".agent-sync-stamp");
  }

  /* v8 ignore start */
  private async canSkipSync(targets: AgentInstructionTarget[]): Promise<boolean> {
    try {
      const stamp = JSON.parse(await readFile(this.syncStampPath, "utf8")) as AgentSyncStamp;
      const [sourceFingerprint, targetFingerprints] = await Promise.all([
        this.fingerprint.source(),
        this.fingerprint.targets(targets),
      ]);
      return (
        sourceFingerprint !== undefined &&
        targetFingerprints !== undefined &&
        stamp.sourceFingerprint === sourceFingerprint &&
        JSON.stringify(stamp.targetFingerprints) === JSON.stringify(targetFingerprints)
      );
    } catch {
      return false;
    }
  }

  private async writeSyncStamp(targets: AgentInstructionTarget[]): Promise<void> {
    try {
      const [sourceFingerprint, targetFingerprints] = await Promise.all([
        this.fingerprint.source(),
        this.fingerprint.targets(targets.map((target) => ({ ...target, existed: true }))),
      ]);
      if (!sourceFingerprint || !targetFingerprints) return;
      await writeFile(
        this.syncStampPath,
        `${JSON.stringify({ sourceFingerprint, targetFingerprints } satisfies AgentSyncStamp)}\n`,
        "utf8",
      );
    } catch {
      // non-critical
    }
  }
  /* v8 ignore stop */

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

  renderBlock(toolList: string, migrationInstructions = ""): string {
    return `${StartMarker}

## Rig local tools

${RigAgentInstructions}${migrationInstructions ? `${migrationInstructions}\n\n` : ""}
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
    if ((await this.isFile(path)) && !(await this.isIgnored(path))) {
      await this.setTarget(targets, path, true, scope);
    }
  }

  private async addClaudeDirectoryTarget(
    targets: Map<string, AgentInstructionTarget>,
    directory: string,
    scope: AgentInstructionTarget["scope"],
  ): Promise<void> {
    const path = join(directory, "CLAUDE.md");
    const fileExists = await this.isFile(path);
    if (fileExists && (await this.isIgnored(path))) return;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.readText(configPath));
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
    const nextScope = current?.scope === "all" || scope === "all" ? "all" : "visible";
    if (!current || path < current.path) targets.set(key, { path, existed, scope: nextScope });
    else current.scope = nextScope;
  }

  private async upsertManagedBlock(
    target: AgentInstructionTarget,
    block: string,
  ): Promise<boolean> {
    const existing = target.existed ? await this.readText(target.path) : "";
    const nextBody = this.managedBlockPattern().test(existing)
      ? existing.replace(this.managedBlockPattern(), block)
      : this.appendBlock(existing, block);
    const next = `${nextBody.trimEnd()}\n`;

    if (next === existing) return false;

    await this.writeText(target.path, next);
    return true;
  }

  /* v8 ignore next 15 */
  private async projectHasRegistry(): Promise<boolean> {
    try {
      const config = JSON.parse(await readFile(this.paths.configPath, "utf8")) as {
        baseRegistryDir?: string;
        customRegistries?: string[];
      };
      const projectRoot = await this.safeRealPath(this.projectRoot());
      const prefix = `${projectRoot}/`;
      const registries = [
        this.paths.resolve(config.baseRegistryDir ?? ""),
        ...(config.customRegistries ?? []).map((path) => this.paths.resolve(path)),
      ];
      const resolved = await Promise.all(registries.map((path) => this.safeRealPath(path)));
      return resolved.some((path) => path === projectRoot || path.startsWith(prefix));
    } catch {
      return false;
    }
  }

  /* v8 ignore next 12 */
  private async removeManagedBlock(target: AgentInstructionTarget): Promise<boolean> {
    if (!target.existed) return false;
    const existing = await this.readText(target.path);
    if (!this.managedBlockPattern().test(existing)) return false;
    const next = existing
      .replace(this.managedBlockPattern(), "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (next === existing.trim()) return false;
    await this.writeText(target.path, next ? `${next}\n` : "");
    return true;
  }

  private async readText(path: string): Promise<string> {
    const bun = this.bunFileApi();
    /* v8 ignore next */
    if (bun) return bun.file(path).text();
    return readFile(path, "utf8");
  }

  private async writeText(path: string, content: string): Promise<void> {
    const bun = this.bunFileApi();
    /* v8 ignore next 4 */
    if (bun) {
      await bun.write(path, content);
      return;
    }
    await writeFile(path, content, "utf8");
  }

  private bunFileApi():
    | {
        file(path: string): { text(): Promise<string> };
        write(path: string, content: string): Promise<number>;
      }
    | undefined {
    const candidate = (
      globalThis as typeof globalThis & {
        Bun?: { file?: unknown; write?: unknown };
      }
    ).Bun;
    /* v8 ignore next */
    if (typeof candidate?.file === "function" && typeof candidate.write === "function")
      return candidate as never;
    return undefined;
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

  private async isIgnored(path: string): Promise<boolean> {
    try {
      return (await this.readText(path)).includes(IgnoreMarker);
    } catch {
      return false;
    }
  }

  private async realPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  private async safeRealPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      /* v8 ignore next -- unresolved registry paths are compared in normalized form */
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
