import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineService } from "../../../define.ts";
import { AtomicFileWriterClass, BoundedFileLockClass } from "../repo/file-lock.ts";
import { RigPathsClass } from "../repo/rig-paths.ts";

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

type RigMigrationPromptStoreDeps = {
  paths: RigPathsClass;
  lock: Pick<BoundedFileLockClass, "run">;
  writer: Pick<AtomicFileWriterClass, "write">;
  readFile: typeof readFile;
  nowIso: () => string;
};

function createRigMigrationPromptStoreDeps(paths: RigPathsClass): RigMigrationPromptStoreDeps {
  return {
    paths,
    lock: new BoundedFileLockClass(paths.migrationPromptStatePath),
    writer: new AtomicFileWriterClass(),
    readFile,
    nowIso() {
      return new Date().toISOString();
    },
  };
}

function emptyPromptState(_params: {}): RigMigrationPromptState {
  return { version: 1, prompts: {} };
}

function isPromptState(params: { value: unknown }): params is { value: RigMigrationPromptState } {
  return (
    typeof params.value === "object" &&
    params.value !== null &&
    !Array.isArray(params.value) &&
    (params.value as { version?: unknown }).version === 1 &&
    typeof (params.value as { prompts?: unknown }).prompts === "object" &&
    (params.value as { prompts?: unknown }).prompts !== null &&
    !Array.isArray((params.value as { prompts?: unknown }).prompts)
  );
}

const RigMigrationPromptStoreProductionDeps = createRigMigrationPromptStoreDeps(
  new RigPathsClass(),
);

export class RigMigrationPromptStoreService extends defineService({
  params: {},
  deps: RigMigrationPromptStoreProductionDeps,
}) {
  private async read(_params: {}): Promise<RigMigrationPromptState> {
    try {
      const candidate = {
        value: JSON.parse(
          await this.deps.readFile(this.deps.paths.migrationPromptStatePath, "utf8"),
        ) as unknown,
      };
      if (!isPromptState(candidate)) return emptyPromptState({});
      return candidate.value;
    } catch {
      return emptyPromptState({});
    }
  }

  private async write(params: { state: RigMigrationPromptState }): Promise<void> {
    await this.deps.writer.write(
      this.deps.paths.migrationPromptStatePath,
      `${JSON.stringify(params.state, null, 2)}\n`,
    );
  }

  public async hasPrompted(params: { promptId: string }): Promise<boolean> {
    const state = await this.read({});
    return state.prompts[params.promptId] !== undefined;
  }

  public async markPrompted(params: { promptId: string }): Promise<void> {
    await this.deps.lock.run(async () => {
      const state = await this.read({});
      state.prompts[params.promptId] ??= { shownAt: this.deps.nowIso() };
      await this.write({ state });
    });
  }
}

export const RigMigrationPromptStore = new RigMigrationPromptStoreService();

export type RigMigrationPromptStoreClass = {
  hasPrompted(promptId: string): Promise<boolean>;
  markPrompted(promptId: string): Promise<void>;
};

type RigMigrationPromptStoreConstructor = {
  new (paths: RigPathsClass): RigMigrationPromptStoreClass;
  readonly prototype: RigMigrationPromptStoreClass;
};

type RigMigrationPromptStoreAdapter = RigMigrationPromptStoreClass & {
  readonly resource: RigMigrationPromptStoreService;
};

const RigMigrationPromptStoreClassAdapter = function constructRigMigrationPromptStore(
  this: RigMigrationPromptStoreAdapter,
  paths: RigPathsClass,
): void {
  Object.defineProperty(this, "resource", {
    value: new RigMigrationPromptStoreService({
      params: {},
      deps: createRigMigrationPromptStoreDeps(paths),
    }),
  });
};
Object.defineProperty(RigMigrationPromptStoreClassAdapter, "name", {
  value: "RigMigrationPromptStoreClass",
});
Object.defineProperties(RigMigrationPromptStoreClassAdapter.prototype, {
  hasPrompted: {
    configurable: true,
    value: function hasPrompted(this: RigMigrationPromptStoreAdapter, promptId: string) {
      return this.resource.hasPrompted({ promptId });
    },
    writable: true,
  },
  markPrompted: {
    configurable: true,
    value: function markPrompted(this: RigMigrationPromptStoreAdapter, promptId: string) {
      return this.resource.markPrompted({ promptId });
    },
    writable: true,
  },
});

export const RigMigrationPromptStoreClass =
  RigMigrationPromptStoreClassAdapter as unknown as RigMigrationPromptStoreConstructor;

type RigDirectoryMigrationServiceDeps = {
  paths: RigPathsClass;
  promptStore: RigMigrationPromptStoreClass;
  exists: typeof existsSync;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
  join: typeof join;
};

function createRigDirectoryMigrationServiceDeps(
  paths: RigPathsClass,
  promptStore: RigMigrationPromptStoreClass = new RigMigrationPromptStoreClass(paths),
): RigDirectoryMigrationServiceDeps {
  return {
    paths,
    promptStore,
    exists: existsSync,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
    join,
  };
}

const RigDirectoryMigrationServiceProductionDeps = createRigDirectoryMigrationServiceDeps(
  new RigPathsClass(),
);

export class RigDirectoryMigrationService extends defineService({
  params: {},
  deps: RigDirectoryMigrationServiceProductionDeps,
}) {
  private async directoryExists(params: { path: string }): Promise<boolean> {
    try {
      return (await this.deps.stat(params.path)).isDirectory();
    } catch {
      return false;
    }
  }

  private async visibleEntries(params: { path: string }): Promise<string[]> {
    return (await this.deps.readdir(params.path)).filter(function keepVisible(entry) {
      return entry !== ".DS_Store";
    });
  }

  private isLegacyBaseRegistry(params: { value: unknown }): boolean {
    return (
      typeof params.value === "string" &&
      (params.value === this.deps.paths.legacyDefaultBaseRegistryDir ||
        this.deps.paths.resolve(params.value) ===
          this.deps.join(this.deps.paths.legacyRigDir, "tools"))
    );
  }

  private async rewriteMigratedConfig(_params: {}): Promise<boolean> {
    const configPath = this.deps.paths.configPath;
    if (!this.deps.exists(configPath)) return false;

    const parsed = JSON.parse(await this.deps.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (!this.isLegacyBaseRegistry({ value: parsed.baseRegistryDir })) return false;

    parsed.baseRegistryDir = this.deps.paths.defaultBaseRegistryDir;
    await this.deps.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  }

  private async hasDefaultCurrentConfig(params: { currentDir: string }): Promise<boolean> {
    try {
      const parsed = JSON.parse(
        await this.deps.readFile(this.deps.join(params.currentDir, "rig.json"), "utf8"),
      ) as {
        version?: unknown;
        baseRegistryDir?: unknown;
        customRegistries?: unknown;
        cronJobs?: unknown;
      };
      return (
        parsed.version === 1 &&
        parsed.baseRegistryDir === this.deps.paths.defaultBaseRegistryDir &&
        Array.isArray(parsed.customRegistries) &&
        parsed.customRegistries.length === 0 &&
        (parsed.cronJobs === undefined ||
          (Array.isArray(parsed.cronJobs) && parsed.cronJobs.length === 0))
      );
    } catch {
      return false;
    }
  }

  private async hasEmptyGeneratedRegistry(params: { currentDir: string }): Promise<boolean> {
    const toolsDir = this.deps.join(params.currentDir, "tools");
    if (!(await this.directoryExists({ path: toolsDir }))) return true;
    const entries = await this.visibleEntries({ path: toolsDir });
    return entries.every(function isGeneratedEntry(entry) {
      return entry === "tsconfig.json";
    });
  }

  private async hasEmptyCronDirectory(params: { currentDir: string }): Promise<boolean> {
    const cronDir = this.deps.join(params.currentDir, "cron");
    if (!(await this.directoryExists({ path: cronDir }))) return true;
    return (await this.visibleEntries({ path: cronDir })).length === 0;
  }

  private async hasOnlyGeneratedCurrentEntries(params: { currentDir: string }): Promise<boolean> {
    const entries = await this.visibleEntries({ path: params.currentDir });
    return entries.every(function isGeneratedEntry(entry) {
      return [
        "rig.json",
        "runtime",
        "tools",
        "update-check.json",
        "cron",
        "migration-prompts.json",
      ].includes(entry);
    });
  }

  private async canReplaceCurrentDirectory(params: { currentDir: string }): Promise<boolean> {
    return (
      (await this.hasDefaultCurrentConfig(params)) &&
      (await this.hasEmptyGeneratedRegistry(params)) &&
      (await this.hasEmptyCronDirectory(params)) &&
      (await this.hasOnlyGeneratedCurrentEntries(params))
    );
  }

  private async hasLegacyState(params: { legacyDir: string }): Promise<boolean> {
    return (
      (await this.directoryExists({ path: params.legacyDir })) &&
      (this.deps.exists(this.deps.join(params.legacyDir, "rig.json")) ||
        this.deps.exists(this.deps.join(params.legacyDir, "tools")))
    );
  }

  public async migrateIfNeeded(_params: {}): Promise<RigDirectoryMigrationResult | undefined> {
    const legacyDir = this.deps.paths.legacyRigDir;
    const currentDir = this.deps.paths.rigDir;

    if (!(await this.hasLegacyState({ legacyDir }))) return undefined;

    const currentExists = this.deps.exists(currentDir);
    if (currentExists && !(await this.canReplaceCurrentDirectory({ currentDir }))) {
      if (await this.deps.promptStore.hasPrompted(RigHomeDirectoryMigrationPromptId)) {
        return undefined;
      }
      return {
        promptId: RigHomeDirectoryMigrationPromptId,
        status: "manual",
        legacyDir,
        currentDir,
        configUpdated: false,
        reason: "Rig found data in both the old and new folders.",
      };
    }

    if (currentExists) await this.deps.rm(currentDir, { recursive: true, force: true });
    await this.deps.mkdir(this.deps.paths.homeDir, { recursive: true });
    await this.deps.rename(legacyDir, currentDir);

    return {
      promptId: RigHomeDirectoryMigrationPromptId,
      status: "migrated",
      legacyDir,
      currentDir,
      configUpdated: await this.rewriteMigratedConfig({}),
    };
  }
}

export const RigDirectoryMigration = new RigDirectoryMigrationService();

export type RigDirectoryMigrationServiceClass = {
  migrateIfNeeded(): Promise<RigDirectoryMigrationResult | undefined>;
};

type RigDirectoryMigrationServiceConstructor = {
  new (
    paths: RigPathsClass,
    promptStore?: RigMigrationPromptStoreClass,
  ): RigDirectoryMigrationServiceClass;
  readonly prototype: RigDirectoryMigrationServiceClass;
};

type RigDirectoryMigrationServiceAdapter = RigDirectoryMigrationServiceClass & {
  readonly resource: RigDirectoryMigrationService;
};

const RigDirectoryMigrationServiceClassAdapter = function constructRigDirectoryMigrationService(
  this: RigDirectoryMigrationServiceAdapter,
  paths: RigPathsClass,
  promptStore?: RigMigrationPromptStoreClass,
): void {
  Object.defineProperty(this, "resource", {
    value: new RigDirectoryMigrationService({
      params: {},
      deps: createRigDirectoryMigrationServiceDeps(paths, promptStore),
    }),
  });
};
Object.defineProperty(RigDirectoryMigrationServiceClassAdapter, "name", {
  value: "RigDirectoryMigrationServiceClass",
});
Object.defineProperty(RigDirectoryMigrationServiceClassAdapter.prototype, "migrateIfNeeded", {
  configurable: true,
  value: function migrateIfNeeded(this: RigDirectoryMigrationServiceAdapter) {
    return this.resource.migrateIfNeeded({});
  },
  writable: true,
});

export const RigDirectoryMigrationServiceClass =
  RigDirectoryMigrationServiceClassAdapter as unknown as RigDirectoryMigrationServiceConstructor;
