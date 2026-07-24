import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { defineRepo } from "../../../define.ts";

export type PathOptions = {
  homeDir?: string;
};

const RigPathsProductionDeps = {
  homedir,
  cwd: process.cwd.bind(process),
  dirname,
  isAbsolute,
  join,
  resolve: resolvePath,
};

export class RigPathsRepo extends defineRepo({
  params: {
    homeDir: undefined,
    defaultBaseRegistryDirValue: "~/rig/tools",
    legacyDefaultBaseRegistryDirValue: "~/.rig/tools",
  } as PathOptions & {
    defaultBaseRegistryDirValue: string;
    legacyDefaultBaseRegistryDirValue: string;
  },
  deps: RigPathsProductionDeps,
}) {
  public homeDir(params: Record<string, never>): string {
    void params;
    return this.params.homeDir
      ? this.deps.resolve(this.deps.cwd(), this.params.homeDir)
      : this.deps.homedir();
  }

  public expandTilde(params: { pathValue: string }): string {
    if (params.pathValue === "~") return this.homeDir({});
    if (params.pathValue.startsWith("~/")) {
      return this.deps.join(this.homeDir({}), params.pathValue.slice(2));
    }
    return params.pathValue;
  }

  public resolve(params: { pathValue: string }): string {
    const expanded = this.expandTilde({ pathValue: params.pathValue });
    return this.deps.isAbsolute(expanded)
      ? this.deps.resolve(expanded)
      : this.deps.resolve(this.deps.cwd(), expanded);
  }

  public rigDir(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.homeDir({}), "rig");
  }

  public legacyRigDir(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.homeDir({}), ".rig");
  }

  public configPath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "rig.json");
  }

  public runtimeDir(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "runtime");
  }

  public runtimeSdkPath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.runtimeDir({}), "sdk.ts");
  }

  public runtimeTypesPath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.runtimeDir({}), "types.d.ts");
  }

  public runtimeGlobalsPath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.runtimeDir({}), "globals.d.ts");
  }

  public runtimeToolTsconfigPath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.runtimeDir({}), "tsconfig.tools.json");
  }

  public cronDir(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "cron");
  }

  public logsDir(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), ".logs");
  }

  public cronWorkerPath(params: { name: string }): string {
    return this.deps.join(this.cronDir({}), `${params.name}.ts`);
  }

  public updateCheckCachePath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "update-check.json");
  }

  public toolMetadataCachePath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "tool-metadata.json");
  }

  public migrationPromptStatePath(params: Record<string, never>): string {
    void params;
    return this.deps.join(this.rigDir({}), "migration-prompts.json");
  }

  public defaultBaseRegistryDir(params: Record<string, never>): string {
    void params;
    return this.params.defaultBaseRegistryDirValue;
  }

  public legacyDefaultBaseRegistryDir(params: Record<string, never>): string {
    void params;
    return this.params.legacyDefaultBaseRegistryDirValue;
  }

  public parentDir(params: { pathValue: string }): string {
    return this.deps.dirname(params.pathValue);
  }
}

export const RigPaths = new RigPathsRepo();

export type RigPathsClass = {
  readonly homeDir: string;
  readonly rigDir: string;
  readonly legacyRigDir: string;
  readonly configPath: string;
  readonly runtimeDir: string;
  readonly runtimeSdkPath: string;
  readonly runtimeTypesPath: string;
  readonly runtimeGlobalsPath: string;
  readonly runtimeToolTsconfigPath: string;
  readonly cronDir: string;
  readonly logsDir: string;
  readonly updateCheckCachePath: string;
  readonly toolMetadataCachePath: string;
  readonly migrationPromptStatePath: string;
  readonly defaultBaseRegistryDir: string;
  readonly legacyDefaultBaseRegistryDir: string;
  expandTilde(pathValue: string): string;
  resolve(pathValue: string): string;
  cronWorkerPath(name: string): string;
  parentDir(pathValue: string): string;
};

type RigPathsConstructor = {
  new (options?: PathOptions): RigPathsClass;
  readonly prototype: RigPathsClass;
};

function RigPathsConstructorAdapter(this: RigPathsClass, options: PathOptions = {}) {
  const Paths = new RigPathsRepo({
    params: {
      homeDir: options.homeDir,
      defaultBaseRegistryDirValue: "~/rig/tools",
      legacyDefaultBaseRegistryDirValue: "~/.rig/tools",
    },
    deps: RigPathsProductionDeps,
  });

  Object.defineProperties(this, {
    homeDir: { configurable: true, get: () => Paths.homeDir({}) },
    rigDir: { configurable: true, get: () => Paths.rigDir({}) },
    legacyRigDir: { configurable: true, get: () => Paths.legacyRigDir({}) },
    configPath: { configurable: true, get: () => Paths.configPath({}) },
    runtimeDir: { configurable: true, get: () => Paths.runtimeDir({}) },
    runtimeSdkPath: { configurable: true, get: () => Paths.runtimeSdkPath({}) },
    runtimeTypesPath: { configurable: true, get: () => Paths.runtimeTypesPath({}) },
    runtimeGlobalsPath: { configurable: true, get: () => Paths.runtimeGlobalsPath({}) },
    runtimeToolTsconfigPath: {
      configurable: true,
      get: () => Paths.runtimeToolTsconfigPath({}),
    },
    cronDir: { configurable: true, get: () => Paths.cronDir({}) },
    logsDir: { configurable: true, get: () => Paths.logsDir({}) },
    updateCheckCachePath: {
      configurable: true,
      get: () => Paths.updateCheckCachePath({}),
    },
    toolMetadataCachePath: {
      configurable: true,
      get: () => Paths.toolMetadataCachePath({}),
    },
    migrationPromptStatePath: {
      configurable: true,
      get: () => Paths.migrationPromptStatePath({}),
    },
    defaultBaseRegistryDir: {
      configurable: true,
      get: () => Paths.defaultBaseRegistryDir({}),
    },
    legacyDefaultBaseRegistryDir: {
      configurable: true,
      get: () => Paths.legacyDefaultBaseRegistryDir({}),
    },
    expandTilde: {
      configurable: true,
      value: (pathValue: string) => Paths.expandTilde({ pathValue }),
      writable: true,
    },
    resolve: {
      configurable: true,
      value: (pathValue: string) => Paths.resolve({ pathValue }),
      writable: true,
    },
    cronWorkerPath: {
      configurable: true,
      value: (name: string) => Paths.cronWorkerPath({ name }),
      writable: true,
    },
    parentDir: {
      configurable: true,
      value: (pathValue: string) => Paths.parentDir({ pathValue }),
      writable: true,
    },
  });
}

export const RigPathsClass = RigPathsConstructorAdapter as unknown as RigPathsConstructor;
