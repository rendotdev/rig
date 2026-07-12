import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RigErrorClass } from "../../errors/RigError";
import { RuntimeSupportClass } from "../../runtime/support";
import {
  RigDirectoryMigrationServiceClass,
  RigMigrationPromptStoreClass,
  type RigDirectoryMigrationResult,
} from "../migration";
import { RigPathsClass, type PathOptions } from "../paths";
import { rigConfigDefaults, RigConfigSchema, type RigConfig } from "../schema";
import { AtomicFileWriterClass, BoundedFileLockClass, type FileLockOptions } from "../file-lock";

export type ConfigOptions = PathOptions & {
  configLock?: FileLockOptions;
};

export type RigConfigMutator = (config: RigConfig) => RigConfig | Promise<RigConfig>;

export type RegistryEntry = {
  kind: "base" | "custom";
  path: string;
};

export class RigConfigStoreClass {
  private readonly paths: RigPathsClass;
  private readonly runtimeSupport: RuntimeSupportClass;
  private readonly lock: BoundedFileLockClass;
  private readonly writer = new AtomicFileWriterClass();
  private migration?: RigDirectoryMigrationResult;

  constructor(options: ConfigOptions = {}) {
    this.paths = new RigPathsClass(options);
    this.runtimeSupport = new RuntimeSupportClass(options);
    this.lock = new BoundedFileLockClass(this.paths.configPath, options.configLock);
  }

  migrationResult(): RigDirectoryMigrationResult | undefined {
    return this.migration;
  }

  async acknowledgeMigrationPrompt(): Promise<void> {
    if (this.migration?.status !== "manual") return;
    await new RigMigrationPromptStoreClass(this.paths).markPrompted(this.migration.promptId);
  }

  async ensure(): Promise<RigConfig> {
    this.migration = await new RigDirectoryMigrationServiceClass(this.paths).migrateIfNeeded();
    await mkdir(this.paths.rigDir, { recursive: true });
    if (!existsSync(this.paths.configPath)) {
      await this.lock.run(async () => {
        if (!existsSync(this.paths.configPath)) {
          await this.writeUnlocked(rigConfigDefaults.create());
        }
      });
    }

    const config = await this.read();
    const registries = this.registryEntries(config);
    await mkdir(this.resolvedBaseRegistry(config), { recursive: true });
    await this.runtimeSupport.ensure(registries.map((registry) => registry.path));
    return config;
  }

  async read(): Promise<RigConfig> {
    let raw: string;
    try {
      raw = await readFile(this.paths.configPath, "utf8");
    } catch (error) {
      throw new RigErrorClass(
        "CONFIG_INVALID",
        `Could not read config at ${this.paths.configPath}.`,
        {
          error,
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RigErrorClass(
        "CONFIG_INVALID",
        `Config is not valid JSON at ${this.paths.configPath}.`,
        {
          error,
        },
      );
    }

    const result = RigConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new RigErrorClass("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }

    return result.data;
  }

  async write(config: RigConfig): Promise<void> {
    await this.lock.run(() => this.writeUnlocked(config));
  }

  async update(mutator: RigConfigMutator): Promise<RigConfig> {
    return this.lock.run(async () => {
      const current = existsSync(this.paths.configPath)
        ? await this.read()
        : rigConfigDefaults.create();
      const next = await mutator(current);
      return this.writeUnlocked(next);
    });
  }

  private async writeUnlocked(config: RigConfig): Promise<RigConfig> {
    const result = RigConfigSchema.safeParse(config);
    if (!result.success) {
      throw new RigErrorClass("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }

    await this.writer.write(this.paths.configPath, `${JSON.stringify(result.data, null, 2)}\n`);
    return result.data;
  }

  resolvedBaseRegistry(config: RigConfig): string {
    return this.paths.resolve(config.baseRegistryDir || this.paths.defaultBaseRegistryDir);
  }

  resolvedCustomRegistries(config: RigConfig): string[] {
    return config.customRegistries.map((pathValue) => this.paths.resolve(pathValue));
  }

  registryEntries(config: RigConfig): RegistryEntry[] {
    return [
      { kind: "base", path: this.resolvedBaseRegistry(config) },
      ...this.resolvedCustomRegistries(config).map((path) => ({ kind: "custom" as const, path })),
    ];
  }
}
