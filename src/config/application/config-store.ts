import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { RigErrorClass } from "../../errors/RigError";
import { RuntimeSupportClass } from "../../runtime/support";
import { rigConfigDefaults } from "../../domains/settings/config/config-defaults.ts";
import { RigConfigSchema, type RigConfig } from "../../domains/settings/types/config-schema.ts";
import type { AtomicFileWriterClass } from "../atomic-file-writer";
import type { BoundedFileLockClass, FileLockOptions } from "../file-lock";
import type { RigDirectoryMigrationResult } from "../migration";
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
  "configPath" | "defaultBaseRegistryDir" | "legacyRigDir" | "resolve" | "rigDir"
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
    return {
      async run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
        const { BoundedFileLockClass } = await import("../file-lock");
        return await new BoundedFileLockClass(params.path, params.options).run(operation);
      },
    };
  },
  createWriter() {
    return {
      async write(path, content) {
        const { AtomicFileWriterClass } = await import("../atomic-file-writer");
        await new AtomicFileWriterClass().write(path, content);
      },
    };
  },
  async migrateDirectory(paths) {
    if (!existsSync(paths.legacyRigDir)) return undefined;
    const { RigDirectoryMigrationServiceClass } = await import("../migration");
    return await new RigDirectoryMigrationServiceClass(paths).migrateIfNeeded();
  },
  async markMigrationPrompted(params) {
    const { RigMigrationPromptStoreClass } = await import("../migration");
    await new RigMigrationPromptStoreClass(params.paths).markPrompted(params.promptId);
  },
  mkdir,
  exists: existsSync,
  readFile,
};

export class RigConfigStoreService {
  public static readonly defaultConstruction = {
    params: {} as ConfigOptions,
    deps: RigConfigStoreServiceProductionDeps,
  };
  protected readonly params: (typeof RigConfigStoreService.defaultConstruction)["params"];
  protected readonly deps: (typeof RigConfigStoreService.defaultConstruction)["deps"];

  public constructor(
    props: typeof RigConfigStoreService.defaultConstruction = RigConfigStoreService.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
    this.paths = this.deps.createPaths(this.params);
    this.runtimeSupport = this.deps.createRuntimeSupport(this.params);
    this.lock = this.deps.createLock({
      path: this.paths.configPath,
      options: this.params.configLock,
    });
    this.writer = this.deps.createWriter();
  }

  private readonly paths: RigConfigPaths;
  private readonly runtimeSupport: RigConfigRuntimeSupport;
  private readonly lock: RigConfigLock;
  private readonly writer: RigConfigWriter;
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

export class RigConfigStoreClass {
  public readonly resource: RigConfigStoreService;

  public constructor(options: ConfigOptions = {}) {
    this.resource = new RigConfigStoreService({
      params: options,
      deps: RigConfigStoreServiceProductionDeps,
    });
  }

  public migrationResult(): RigDirectoryMigrationResult | undefined {
    return this.resource.migrationResult({});
  }

  public acknowledgeMigrationPrompt(): Promise<void> {
    return this.resource.acknowledgeMigrationPrompt({});
  }

  public ensure(): Promise<RigConfig> {
    return this.resource.ensure({});
  }

  public read(): Promise<RigConfig> {
    return this.resource.read({});
  }

  public write(config: RigConfig): Promise<void> {
    return this.resource.write({ config });
  }

  public update(mutator: RigConfigMutator): Promise<RigConfig> {
    return this.resource.update({ mutator });
  }

  public resolvedBaseRegistry(config: RigConfig): string {
    return this.resource.resolvedBaseRegistry({ config });
  }

  public resolvedCustomRegistries(config: RigConfig): string[] {
    return this.resource.resolvedCustomRegistries({ config });
  }

  public registryEntries(config: RigConfig): RegistryEntry[] {
    return this.resource.registryEntries({ config });
  }
}
