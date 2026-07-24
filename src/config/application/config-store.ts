import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { defineService } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import { RuntimeSupportClass } from "../../runtime/support";
import {
  rigConfigDefaults,
  RigConfigSchema,
  type RigConfig,
} from "../../domains/settings/index.ts";
import { AtomicFileWriterClass, BoundedFileLockClass, type FileLockOptions } from "../file-lock";
import {
  RigDirectoryMigrationServiceClass,
  RigMigrationPromptStoreClass,
  type RigDirectoryMigrationResult,
} from "../migration";
import { RigPathsClass, type PathOptions } from "../paths";

export type ConfigOptions = PathOptions & {
  configLock?: FileLockOptions;
};

export type RigConfigMutator = (config: RigConfig) => RigConfig | Promise<RigConfig>;

export type RegistryEntry = {
  kind: "base" | "custom";
  path: string;
};

type RigConfigPaths = Pick<
  RigPathsClass,
  "configPath" | "defaultBaseRegistryDir" | "resolve" | "rigDir"
>;
type RigConfigRuntimeSupport = Pick<RuntimeSupportClass, "ensure">;
type RigConfigLock = Pick<BoundedFileLockClass, "run">;
type RigConfigWriter = Pick<AtomicFileWriterClass, "write">;

type RigConfigStoreServiceDeps = {
  createPaths: (options: ConfigOptions) => RigConfigPaths;
  createRuntimeSupport: (options: ConfigOptions) => RigConfigRuntimeSupport;
  createLock: (params: { path: string; options?: FileLockOptions }) => RigConfigLock;
  createWriter: () => RigConfigWriter;
  migrateDirectory: (paths: RigPathsClass) => Promise<RigDirectoryMigrationResult | undefined>;
  markMigrationPrompted: (params: { paths: RigPathsClass; promptId: string }) => Promise<void>;
  mkdir: typeof mkdir;
  exists: typeof existsSync;
  readFile: typeof readFile;
};

const RigConfigStoreServiceProductionDeps: RigConfigStoreServiceDeps = {
  createPaths(options) {
    return new RigPathsClass(options);
  },
  createRuntimeSupport(options) {
    return new RuntimeSupportClass(options);
  },
  createLock(params) {
    return new BoundedFileLockClass(params.path, params.options);
  },
  createWriter() {
    return new AtomicFileWriterClass();
  },
  async migrateDirectory(paths) {
    return await new RigDirectoryMigrationServiceClass(paths).migrateIfNeeded();
  },
  async markMigrationPrompted(params) {
    await new RigMigrationPromptStoreClass(params.paths).markPrompted(params.promptId);
  },
  mkdir,
  exists: existsSync,
  readFile,
};

export class RigConfigStoreService extends defineService({
  params: {} as ConfigOptions,
  deps: RigConfigStoreServiceProductionDeps,
}) {
  private readonly paths = this.deps.createPaths(this.params);
  private readonly runtimeSupport = this.deps.createRuntimeSupport(this.params);
  private readonly lock = this.deps.createLock({
    path: this.paths.configPath,
    options: this.params.configLock,
  });
  private readonly writer = this.deps.createWriter();
  private migration: RigDirectoryMigrationResult | undefined;

  public migrationResult(_params: {}): RigDirectoryMigrationResult | undefined {
    return this.migration;
  }

  public async acknowledgeMigrationPrompt(_params: {}): Promise<void> {
    if (this.migration?.status !== "manual") return;
    await this.deps.markMigrationPrompted({
      paths: this.paths as RigPathsClass,
      promptId: this.migration.promptId,
    });
  }

  public async read(_params: {}): Promise<RigConfig> {
    let raw: string;
    try {
      raw = await this.deps.readFile(this.paths.configPath, "utf8");
    } catch (error) {
      throw new RigErrorClass(
        "CONFIG_INVALID",
        `Could not read config at ${this.paths.configPath}.`,
        { error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RigErrorClass(
        "CONFIG_INVALID",
        `Config is not valid JSON at ${this.paths.configPath}.`,
        { error },
      );
    }

    const result = RigConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new RigErrorClass("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }
    return result.data;
  }

  private async writeUnlocked(params: { config: RigConfig }): Promise<RigConfig> {
    const result = RigConfigSchema.safeParse(params.config);
    if (!result.success) {
      throw new RigErrorClass("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }

    await this.writer.write(this.paths.configPath, `${JSON.stringify(result.data, null, 2)}\n`);
    return result.data;
  }

  public resolvedBaseRegistry(params: { config: RigConfig }): string {
    return this.paths.resolve(params.config.baseRegistryDir || this.paths.defaultBaseRegistryDir);
  }

  public resolvedCustomRegistries(params: { config: RigConfig }): string[] {
    return params.config.customRegistries.map((pathValue) => this.paths.resolve(pathValue));
  }

  public registryEntries(params: { config: RigConfig }): RegistryEntry[] {
    return [
      { kind: "base", path: this.resolvedBaseRegistry(params) },
      ...this.resolvedCustomRegistries(params).map(function customRegistry(path) {
        return { kind: "custom" as const, path };
      }),
    ];
  }

  public async ensure(_params: {}): Promise<RigConfig> {
    this.migration = await this.deps.migrateDirectory(this.paths as RigPathsClass);
    await this.deps.mkdir(this.paths.rigDir, { recursive: true });
    if (!this.deps.exists(this.paths.configPath)) {
      await this.lock.run(async () => {
        if (!this.deps.exists(this.paths.configPath)) {
          await this.writeUnlocked({ config: rigConfigDefaults.create() });
        }
      });
    }

    const rigConfig = await this.read({});
    const registries = this.registryEntries({ config: rigConfig });
    await this.deps.mkdir(this.resolvedBaseRegistry({ config: rigConfig }), { recursive: true });
    await this.runtimeSupport.ensure(
      registries.map(function registryPath(registry) {
        return registry.path;
      }),
    );
    return rigConfig;
  }

  public async write(params: { config: RigConfig }): Promise<void> {
    await this.lock.run(() => this.writeUnlocked(params));
  }

  public async update(params: { mutator: RigConfigMutator }): Promise<RigConfig> {
    return await this.lock.run(async () => {
      const current = this.deps.exists(this.paths.configPath)
        ? await this.read({})
        : rigConfigDefaults.create();
      const next = await params.mutator(current);
      return await this.writeUnlocked({ config: next });
    });
  }
}

export type RigConfigStoreClass = {
  migrationResult(): RigDirectoryMigrationResult | undefined;
  acknowledgeMigrationPrompt(): Promise<void>;
  ensure(): Promise<RigConfig>;
  read(): Promise<RigConfig>;
  write(config: RigConfig): Promise<void>;
  update(mutator: RigConfigMutator): Promise<RigConfig>;
  resolvedBaseRegistry(config: RigConfig): string;
  resolvedCustomRegistries(config: RigConfig): string[];
  registryEntries(config: RigConfig): RegistryEntry[];
};

type RigConfigStoreConstructor = {
  new (options?: ConfigOptions): RigConfigStoreClass;
  readonly prototype: RigConfigStoreClass;
};

type RigConfigStoreAdapter = RigConfigStoreClass & {
  readonly resource: RigConfigStoreService;
};

const RigConfigStoreClassAdapter = function constructRigConfigStore(
  this: RigConfigStoreAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new RigConfigStoreService({
      params: options,
      deps: RigConfigStoreServiceProductionDeps,
    }),
  });
};
Object.defineProperty(RigConfigStoreClassAdapter, "name", { value: "RigConfigStoreClass" });
Object.defineProperties(RigConfigStoreClassAdapter.prototype, {
  migrationResult: {
    configurable: true,
    value: function migrationResult(this: RigConfigStoreAdapter) {
      return this.resource.migrationResult({});
    },
    writable: true,
  },
  acknowledgeMigrationPrompt: {
    configurable: true,
    value: function acknowledgeMigrationPrompt(this: RigConfigStoreAdapter) {
      return this.resource.acknowledgeMigrationPrompt({});
    },
    writable: true,
  },
  ensure: {
    configurable: true,
    value: function ensure(this: RigConfigStoreAdapter) {
      return this.resource.ensure({});
    },
    writable: true,
  },
  read: {
    configurable: true,
    value: function read(this: RigConfigStoreAdapter) {
      return this.resource.read({});
    },
    writable: true,
  },
  write: {
    configurable: true,
    value: function write(this: RigConfigStoreAdapter, config: RigConfig) {
      return this.resource.write({ config });
    },
    writable: true,
  },
  update: {
    configurable: true,
    value: function update(this: RigConfigStoreAdapter, mutator: RigConfigMutator) {
      return this.resource.update({ mutator });
    },
    writable: true,
  },
  resolvedBaseRegistry: {
    configurable: true,
    value: function resolvedBaseRegistry(this: RigConfigStoreAdapter, config: RigConfig) {
      return this.resource.resolvedBaseRegistry({ config });
    },
    writable: true,
  },
  resolvedCustomRegistries: {
    configurable: true,
    value: function resolvedCustomRegistries(this: RigConfigStoreAdapter, config: RigConfig) {
      return this.resource.resolvedCustomRegistries({ config });
    },
    writable: true,
  },
  registryEntries: {
    configurable: true,
    value: function registryEntries(this: RigConfigStoreAdapter, config: RigConfig) {
      return this.resource.registryEntries({ config });
    },
    writable: true,
  },
});

export const RigConfigStoreClass =
  RigConfigStoreClassAdapter as unknown as RigConfigStoreConstructor;
