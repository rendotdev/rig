import { mkdir } from "node:fs/promises";
import { defineService } from "../../define";
import { RigConfigStoreClass, type ConfigOptions } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { RigErrorClass } from "../../errors/RigError";

type RegistryConfigStore = Pick<RigConfigStoreClass, "ensure" | "registryEntries" | "update">;
type RegistryPaths = Pick<RigPathsClass, "resolve">;

type RegistryConfigServiceDeps = {
  createConfigStore: (options: ConfigOptions) => RegistryConfigStore;
  createPaths: (options: ConfigOptions) => RegistryPaths;
  mkdir: typeof mkdir;
};

const RegistryConfigServiceProductionDeps: RegistryConfigServiceDeps = {
  createConfigStore(options) {
    return new RigConfigStoreClass(options);
  },
  createPaths(options) {
    return new RigPathsClass(options);
  },
  mkdir,
};

export class RegistryConfigService extends defineService({
  params: {} as ConfigOptions,
  deps: RegistryConfigServiceProductionDeps,
}) {
  private readonly configStore = this.deps.createConfigStore(this.params);
  private readonly paths = this.deps.createPaths(this.params);

  public async list(_params: {}) {
    const rigConfig = await this.configStore.ensure();
    return {
      baseRegistryDir: this.paths.resolve(rigConfig.baseRegistryDir),
      customRegistries: rigConfig.customRegistries.map((pathValue) =>
        this.paths.resolve(pathValue),
      ),
      registries: this.configStore.registryEntries(rigConfig),
    };
  }

  public async add(params: { pathValue: string }) {
    await this.configStore.ensure();
    const target = this.paths.resolve(params.pathValue);
    await this.configStore.update(async (rigConfig) => {
      const existing = rigConfig.customRegistries.map((entry) => this.paths.resolve(entry));
      const base = this.paths.resolve(rigConfig.baseRegistryDir);

      if (target === base) {
        throw new RigErrorClass("CONFIG_INVALID", "The base registry is already configured.", {
          path: target,
        });
      }

      if (existing.includes(target)) return rigConfig;
      await this.deps.mkdir(target, { recursive: true });
      return {
        ...rigConfig,
        customRegistries: [...rigConfig.customRegistries, params.pathValue],
      };
    });

    return await this.list({});
  }

  public async remove(params: { pathValue: string }) {
    await this.configStore.ensure();
    const target = this.paths.resolve(params.pathValue);
    await this.configStore.update((rigConfig) => {
      const next = rigConfig.customRegistries.filter(
        (entry) => this.paths.resolve(entry) !== target,
      );

      if (next.length === rigConfig.customRegistries.length) {
        throw new RigErrorClass(
          "CONFIG_INVALID",
          `Registry is not configured: ${params.pathValue}`,
          { path: target },
        );
      }

      return { ...rigConfig, customRegistries: next };
    });
    return await this.list({});
  }
}

export type RegistryConfigServiceClass = {
  list(): ReturnType<RegistryConfigService["list"]>;
  add(pathValue: string): ReturnType<RegistryConfigService["add"]>;
  remove(pathValue: string): ReturnType<RegistryConfigService["remove"]>;
};

type RegistryConfigServiceConstructor = {
  new (options?: ConfigOptions): RegistryConfigServiceClass;
  readonly prototype: RegistryConfigServiceClass;
};

type RegistryConfigServiceAdapter = RegistryConfigServiceClass & {
  readonly resource: RegistryConfigService;
};

const RegistryConfigServiceClassAdapter = function constructRegistryConfigService(
  this: RegistryConfigServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new RegistryConfigService({
      params: options,
      deps: RegistryConfigServiceProductionDeps,
    }),
  });
};
Object.defineProperty(RegistryConfigServiceClassAdapter, "name", {
  value: "RegistryConfigServiceClass",
});
Object.defineProperties(RegistryConfigServiceClassAdapter.prototype, {
  list: {
    configurable: true,
    value: function list(this: RegistryConfigServiceAdapter) {
      return this.resource.list({});
    },
    writable: true,
  },
  add: {
    configurable: true,
    value: function add(this: RegistryConfigServiceAdapter, pathValue: string) {
      return this.resource.add({ pathValue });
    },
    writable: true,
  },
  remove: {
    configurable: true,
    value: function remove(this: RegistryConfigServiceAdapter, pathValue: string) {
      return this.resource.remove({ pathValue });
    },
    writable: true,
  },
});

export const RegistryConfigServiceClass =
  RegistryConfigServiceClassAdapter as unknown as RegistryConfigServiceConstructor;
