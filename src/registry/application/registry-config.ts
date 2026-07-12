import { mkdir } from "node:fs/promises";
import { RigConfigStoreClass, type ConfigOptions } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { RigErrorClass } from "../../errors/RigError";

export class RegistryConfigServiceClass {
  private readonly configStore: RigConfigStoreClass;
  private readonly paths: RigPathsClass;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStoreClass(options);
    this.paths = new RigPathsClass(options);
  }

  async list() {
    const config = await this.configStore.ensure();
    return {
      baseRegistryDir: this.paths.resolve(config.baseRegistryDir),
      customRegistries: config.customRegistries.map((pathValue) => this.paths.resolve(pathValue)),
      registries: this.configStore.registryEntries(config),
    };
  }

  async add(pathValue: string) {
    await this.configStore.ensure();
    const target = this.paths.resolve(pathValue);
    await this.configStore.update(async (config) => {
      const existing = config.customRegistries.map((entry) => this.paths.resolve(entry));
      const base = this.paths.resolve(config.baseRegistryDir);

      if (target === base) {
        throw new RigErrorClass("CONFIG_INVALID", "The base registry is already configured.", {
          path: target,
        });
      }

      if (existing.includes(target)) return config;
      await mkdir(target, { recursive: true });
      return { ...config, customRegistries: [...config.customRegistries, pathValue] };
    });

    return this.list();
  }

  async remove(pathValue: string) {
    await this.configStore.ensure();
    const target = this.paths.resolve(pathValue);
    await this.configStore.update((config) => {
      const next = config.customRegistries.filter((entry) => this.paths.resolve(entry) !== target);

      if (next.length === config.customRegistries.length) {
        throw new RigErrorClass("CONFIG_INVALID", `Registry is not configured: ${pathValue}`, {
          path: target,
        });
      }

      return { ...config, customRegistries: next };
    });
    return this.list();
  }
}
