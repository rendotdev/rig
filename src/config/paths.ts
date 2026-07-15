import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type PathOptions = {
  homeDir?: string;
};

export class RigPaths {
  private readonly homeOverride?: string;

  constructor(options: PathOptions = {}) {
    this.homeOverride = options.homeDir;
  }

  get homeDir(): string {
    return this.homeOverride ? resolve(this.homeOverride) : homedir();
  }

  expandTilde(pathValue: string): string {
    if (pathValue === "~") return this.homeDir;
    if (pathValue.startsWith("~/")) return join(this.homeDir, pathValue.slice(2));
    return pathValue;
  }

  resolve(pathValue: string): string {
    const expanded = this.expandTilde(pathValue);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
  }

  get rigDir(): string {
    return join(this.homeDir, "rig");
  }

  get legacyRigDir(): string {
    return join(this.homeDir, ".rig");
  }

  get configPath(): string {
    return join(this.rigDir, "rig.json");
  }

  get runtimeDir(): string {
    return join(this.rigDir, "runtime");
  }

  get runtimeSdkPath(): string {
    return join(this.runtimeDir, "sdk.ts");
  }

  get runtimeTypesPath(): string {
    return join(this.runtimeDir, "types.d.ts");
  }

  get runtimeGlobalsPath(): string {
    return join(this.runtimeDir, "globals.d.ts");
  }

  get runtimeToolTsconfigPath(): string {
    return join(this.runtimeDir, "tsconfig.tools.json");
  }

  get runtimeTypecheckAmbientPath(): string {
    return join(this.runtimeDir, "typecheck-ambient.d.ts");
  }

  get cronDir(): string {
    return join(this.rigDir, "cron");
  }

  get logsDir(): string {
    return join(this.rigDir, ".logs");
  }

  cronWorkerPath(name: string): string {
    return join(this.cronDir, `${name}.ts`);
  }

  get updateCheckCachePath(): string {
    return join(this.rigDir, "update-check.json");
  }

  get migrationPromptStatePath(): string {
    return join(this.rigDir, "migration-prompts.json");
  }

  get defaultBaseRegistryDir(): string {
    return "~/rig/tools";
  }

  get legacyDefaultBaseRegistryDir(): string {
    return "~/.rig/tools";
  }

  parentDir(pathValue: string): string {
    return dirname(pathValue);
  }
}
