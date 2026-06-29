import { mkdir } from "node:fs/promises";
import { RigConfigStore, type ConfigOptions } from "../config/config";
import { RigPaths } from "../config/paths";
import { RigError } from "../errors/RigError";

export class RegistryConfigService {
  private readonly configStore: RigConfigStore;
  private readonly paths: RigPaths;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStore(options);
    this.paths = new RigPaths(options);
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
    const config = await this.configStore.read();
    const target = this.paths.resolve(pathValue);
    const existing = config.customRegistries.map((entry) => this.paths.resolve(entry));
    const base = this.paths.resolve(config.baseRegistryDir);

    if (target === base) {
      throw new RigError("CONFIG_INVALID", "The base registry is already configured.", {
        path: target,
      });
    }

    if (!existing.includes(target)) {
      config.customRegistries.push(pathValue);
      await mkdir(target, { recursive: true });
      await this.configStore.write(config);
    }

    return this.list();
  }

  async remove(pathValue: string) {
    await this.configStore.ensure();
    const config = await this.configStore.read();
    const target = this.paths.resolve(pathValue);
    const next = config.customRegistries.filter((entry) => this.paths.resolve(entry) !== target);

    if (next.length === config.customRegistries.length) {
      throw new RigError("CONFIG_INVALID", `Registry is not configured: ${pathValue}`, {
        path: target,
      });
    }

    config.customRegistries = next;
    await this.configStore.write(config);
    return this.list();
  }
}
