import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AtomicFileWriterClass, BoundedFileLockClass } from "../file-lock";
import { RigPathsClass } from "../paths";

export const RigHomeDirectoryMigrationPromptId = "v0.0.19-home-directory";

export type RigDirectoryMigrationResult = {
  promptId: string;
  status: "migrated" | "manual";
  legacyDir: string;
  currentDir: string;
  configUpdated: boolean;
  reason?: string;
};

type RigMigrationPromptState = {
  version: 1;
  prompts: Record<string, { shownAt: string }>;
};

export class RigMigrationPromptStoreClass {
  private readonly lock: BoundedFileLockClass;
  private readonly writer = new AtomicFileWriterClass();

  constructor(private readonly paths: RigPathsClass) {
    this.lock = new BoundedFileLockClass(paths.migrationPromptStatePath);
  }

  async hasPrompted(promptId: string): Promise<boolean> {
    const state = await this.read();
    return state.prompts[promptId] !== undefined;
  }

  async markPrompted(promptId: string): Promise<void> {
    await this.lock.run(async () => {
      const state = await this.read();
      state.prompts[promptId] ??= { shownAt: new Date().toISOString() };
      await this.write(state);
    });
  }

  private async read(): Promise<RigMigrationPromptState> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.migrationPromptStatePath, "utf8"));
      if (!this.isState(parsed)) return this.emptyState();
      return parsed;
    } catch {
      return this.emptyState();
    }
  }

  private async write(state: RigMigrationPromptState): Promise<void> {
    await this.writer.write(
      this.paths.migrationPromptStatePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  private emptyState(): RigMigrationPromptState {
    return { version: 1, prompts: {} };
  }

  private isState(value: unknown): value is RigMigrationPromptState {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { version?: unknown }).version === 1 &&
      typeof (value as { prompts?: unknown }).prompts === "object" &&
      (value as { prompts?: unknown }).prompts !== null &&
      !Array.isArray((value as { prompts?: unknown }).prompts)
    );
  }
}

export class RigDirectoryMigrationServiceClass {
  constructor(
    private readonly paths: RigPathsClass,
    private readonly promptStore = new RigMigrationPromptStoreClass(paths),
  ) {}

  async migrateIfNeeded(): Promise<RigDirectoryMigrationResult | undefined> {
    const legacyDir = this.paths.legacyRigDir;
    const currentDir = this.paths.rigDir;

    if (!(await this.hasLegacyState(legacyDir))) return undefined;

    const currentExists = existsSync(currentDir);
    if (currentExists && !(await this.canReplaceCurrentDirectory(currentDir))) {
      if (await this.promptStore.hasPrompted(RigHomeDirectoryMigrationPromptId)) return undefined;
      return {
        promptId: RigHomeDirectoryMigrationPromptId,
        status: "manual",
        legacyDir,
        currentDir,
        configUpdated: false,
        reason: "Rig found data in both the old and new folders.",
      };
    }

    if (currentExists) await rm(currentDir, { recursive: true, force: true });
    await mkdir(this.paths.homeDir, { recursive: true });
    await rename(legacyDir, currentDir);

    return {
      promptId: RigHomeDirectoryMigrationPromptId,
      status: "migrated",
      legacyDir,
      currentDir,
      configUpdated: await this.rewriteMigratedConfig(),
    };
  }

  private async hasLegacyState(legacyDir: string): Promise<boolean> {
    return (
      (await this.directoryExists(legacyDir)) &&
      (existsSync(join(legacyDir, "rig.json")) || existsSync(join(legacyDir, "tools")))
    );
  }

  private async canReplaceCurrentDirectory(currentDir: string): Promise<boolean> {
    return (
      (await this.hasDefaultCurrentConfig(currentDir)) &&
      (await this.hasEmptyGeneratedRegistry(currentDir)) &&
      (await this.hasEmptyCronDirectory(currentDir)) &&
      (await this.hasOnlyGeneratedCurrentEntries(currentDir))
    );
  }

  private async hasDefaultCurrentConfig(currentDir: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(join(currentDir, "rig.json"), "utf8")) as {
        version?: unknown;
        baseRegistryDir?: unknown;
        customRegistries?: unknown;
        cronJobs?: unknown;
      };
      return (
        parsed.version === 1 &&
        parsed.baseRegistryDir === this.paths.defaultBaseRegistryDir &&
        Array.isArray(parsed.customRegistries) &&
        parsed.customRegistries.length === 0 &&
        (parsed.cronJobs === undefined ||
          (Array.isArray(parsed.cronJobs) && parsed.cronJobs.length === 0))
      );
    } catch {
      return false;
    }
  }

  private async hasEmptyGeneratedRegistry(currentDir: string): Promise<boolean> {
    const toolsDir = join(currentDir, "tools");
    if (!(await this.directoryExists(toolsDir))) return true;
    const entries = await this.visibleEntries(toolsDir);
    return entries.every((entry) => entry === "tsconfig.json");
  }

  private async hasEmptyCronDirectory(currentDir: string): Promise<boolean> {
    const cronDir = join(currentDir, "cron");
    if (!(await this.directoryExists(cronDir))) return true;
    return (await this.visibleEntries(cronDir)).length === 0;
  }

  private async hasOnlyGeneratedCurrentEntries(currentDir: string): Promise<boolean> {
    const entries = await this.visibleEntries(currentDir);
    return entries.every((entry) =>
      [
        "rig.json",
        "runtime",
        "tools",
        "update-check.json",
        "cron",
        "migration-prompts.json",
      ].includes(entry),
    );
  }

  private async rewriteMigratedConfig(): Promise<boolean> {
    const configPath = this.paths.configPath;
    if (!existsSync(configPath)) return false;

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    if (!this.isLegacyBaseRegistry(parsed.baseRegistryDir)) return false;

    parsed.baseRegistryDir = this.paths.defaultBaseRegistryDir;
    await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  }

  private isLegacyBaseRegistry(value: unknown): boolean {
    return (
      typeof value === "string" &&
      (value === this.paths.legacyDefaultBaseRegistryDir ||
        this.paths.resolve(value) === join(this.paths.legacyRigDir, "tools"))
    );
  }

  private async visibleEntries(path: string): Promise<string[]> {
    return (await readdir(path)).filter((entry) => entry !== ".DS_Store");
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
