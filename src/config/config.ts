import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { RigError } from "../errors/RigError";
import { RuntimeSupport } from "../runtime/support";
import { RigPaths, type PathOptions } from "./paths";
import { RigConfigDefaults, RigConfigSchema, type RigConfig } from "./schema";

export type ConfigOptions = PathOptions;

export type RegistryEntry = {
  kind: "base" | "custom";
  path: string;
};

export class RigConfigStore {
  private readonly paths: RigPaths;
  private readonly runtimeSupport: RuntimeSupport;

  constructor(options: ConfigOptions = {}) {
    this.paths = new RigPaths(options);
    this.runtimeSupport = new RuntimeSupport(options);
  }

  async ensure(): Promise<RigConfig> {
    await mkdir(this.paths.rigDir, { recursive: true });
    if (!existsSync(this.paths.configPath)) {
      await this.write(RigConfigDefaults.create());
    }

    const config = await this.read();
    await mkdir(this.resolvedBaseRegistry(config), { recursive: true });
    await this.runtimeSupport.ensure();
    return config;
  }

  async read(): Promise<RigConfig> {
    let raw: string;
    try {
      raw = await readFile(this.paths.configPath, "utf8");
    } catch (error) {
      throw new RigError("CONFIG_INVALID", `Could not read config at ${this.paths.configPath}.`, {
        error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RigError(
        "CONFIG_INVALID",
        `Config is not valid JSON at ${this.paths.configPath}.`,
        {
          error,
        },
      );
    }

    const result = RigConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new RigError("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }

    return result.data;
  }

  async write(config: RigConfig): Promise<void> {
    const result = RigConfigSchema.safeParse(config);
    if (!result.success) {
      throw new RigError("CONFIG_INVALID", "Rig config is invalid.", result.error.flatten());
    }

    await mkdir(dirname(this.paths.configPath), { recursive: true });
    const tmpPath = `${this.paths.configPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.paths.configPath);
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
