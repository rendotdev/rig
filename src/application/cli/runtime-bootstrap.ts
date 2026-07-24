import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineService } from "../../define";

type BunRuntimeSpawn = (
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<Buffer>;

type BunRuntimeGlobalProvider = () => unknown;

export type BunRuntimeBootstrapParams = {
  /** @deprecated Rig now uses the Bun runtime available on PATH. */
  packageRoot?: string;
};

export type BunRuntimeBootstrapDeps = {
  spawn?: BunRuntimeSpawn;
  env?: NodeJS.ProcessEnv;
  bunGlobal?: BunRuntimeGlobalProvider;
};

type BunRuntimeBootstrapServiceDeps = {
  spawn: BunRuntimeSpawn;
  env: NodeJS.ProcessEnv;
  bunGlobal: BunRuntimeGlobalProvider;
};

function runtimeAutoInstallFlag(_params: {}): string {
  return "--install=fallback";
}

const BunRuntimeBootstrapProductionDeps: BunRuntimeBootstrapServiceDeps = {
  spawn: spawnSync,
  env: process.env,
  bunGlobal: function bunGlobal() {
    return (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  },
};

export class BunRuntimeBootstrapService extends defineService({
  params: {} as BunRuntimeBootstrapParams,
  deps: BunRuntimeBootstrapProductionDeps,
}) {
  public shouldBootstrap(_params: {}): boolean {
    return (
      this.deps.bunGlobal() === undefined &&
      this.deps.env.RIG_BUN_BOOTSTRAPPED !== "1" &&
      this.deps.env.RIG_DISABLE_BUN_BOOTSTRAP !== "1"
    );
  }

  public resolveBunPath(_params: {}): string {
    return this.deps.env.RIG_BUN_PATH ?? "bun";
  }

  public run(params: { metaUrl: string; argv: string[] }): number | undefined {
    if (!this.shouldBootstrap({})) return undefined;
    const result = this.deps.spawn(
      this.resolveBunPath({}),
      [runtimeAutoInstallFlag({}), fileURLToPath(params.metaUrl), ...params.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...this.deps.env, RIG_BUN_BOOTSTRAPPED: "1" },
      },
    );
    return result.status ?? 1;
  }

  public autoInstallFlag(_params: {}): string {
    return runtimeAutoInstallFlag({});
  }
}

export const BunRuntimeBootstrapServiceDefault = new BunRuntimeBootstrapService();

export type BunRuntimeBootstrapClass = {
  run(params: { metaUrl: string; argv: string[] }): number | undefined;
  shouldBootstrap(): boolean;
  resolveBunPath(): string;
  autoInstallFlag(): string;
};

type BunRuntimeBootstrapConstructor = {
  new (params: BunRuntimeBootstrapParams, deps: BunRuntimeBootstrapDeps): BunRuntimeBootstrapClass;
  readonly prototype: BunRuntimeBootstrapClass;
};

type BunRuntimeBootstrapAdapter = BunRuntimeBootstrapClass & {
  readonly resource: BunRuntimeBootstrapService;
};

const BunRuntimeBootstrapClassAdapter = function constructBunRuntimeBootstrap(
  this: BunRuntimeBootstrapAdapter,
  params: BunRuntimeBootstrapParams,
  deps: BunRuntimeBootstrapDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new BunRuntimeBootstrapService({
      params,
      deps: {
        spawn: deps.spawn ?? BunRuntimeBootstrapProductionDeps.spawn,
        env: deps.env ?? BunRuntimeBootstrapProductionDeps.env,
        bunGlobal: deps.bunGlobal ?? BunRuntimeBootstrapProductionDeps.bunGlobal,
      },
    }),
  });
};
Object.defineProperty(BunRuntimeBootstrapClassAdapter, "name", {
  value: "BunRuntimeBootstrapClass",
});
Object.defineProperties(BunRuntimeBootstrapClassAdapter.prototype, {
  run: {
    configurable: true,
    value: function run(
      this: BunRuntimeBootstrapAdapter,
      params: { metaUrl: string; argv: string[] },
    ) {
      return this.resource.run(params);
    },
    writable: true,
  },
  shouldBootstrap: {
    configurable: true,
    value: function shouldBootstrap(this: BunRuntimeBootstrapAdapter) {
      return this.resource.shouldBootstrap({});
    },
    writable: true,
  },
  resolveBunPath: {
    configurable: true,
    value: function resolveBunPath(this: BunRuntimeBootstrapAdapter) {
      return this.resource.resolveBunPath({});
    },
    writable: true,
  },
  autoInstallFlag: {
    configurable: true,
    value: function autoInstallFlag(this: BunRuntimeBootstrapAdapter) {
      return this.resource.autoInstallFlag({});
    },
    writable: true,
  },
});

export const BunRuntimeBootstrapClass =
  BunRuntimeBootstrapClassAdapter as unknown as BunRuntimeBootstrapConstructor;
export const BunRuntimeBootstrap = BunRuntimeBootstrapClass;

type CliEntrypointDeps = {
  realpath: (path: string) => string;
  pathToFileUrl: (path: string) => URL;
};

const CliEntrypointProductionDeps: CliEntrypointDeps = {
  realpath: function realpath(path: string) {
    return realpathSync(path);
  },
  pathToFileUrl: function pathToFileUrl(path: string) {
    return pathToFileURL(path);
  },
};

export class CliEntrypointService extends defineService({
  params: {},
  deps: CliEntrypointProductionDeps,
}) {
  public matches(params: { metaUrl: string; argvPath?: string }): boolean {
    if (!params.argvPath) return false;
    try {
      const resolved = this.deps.realpath(params.argvPath);
      return params.metaUrl === this.deps.pathToFileUrl(resolved).href;
    } catch {
      return params.metaUrl === this.deps.pathToFileUrl(params.argvPath).href;
    }
  }
}

export const CliEntrypointServiceDefault = new CliEntrypointService();

export type CliEntrypointClass = {
  matches(params: { metaUrl: string; argvPath?: string }): boolean;
};

type CliEntrypointConstructor = {
  new (params: Record<string, never>, deps: CliEntrypointDeps): CliEntrypointClass;
  readonly prototype: CliEntrypointClass;
};

type CliEntrypointAdapter = CliEntrypointClass & { readonly resource: CliEntrypointService };

const CliEntrypointClassAdapter = function constructCliEntrypoint(
  this: CliEntrypointAdapter,
  _params: Record<string, never>,
  deps: CliEntrypointDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new CliEntrypointService({ params: {}, deps }),
  });
};
Object.defineProperty(CliEntrypointClassAdapter, "name", { value: "CliEntrypointClass" });
Object.defineProperty(CliEntrypointClassAdapter.prototype, "matches", {
  configurable: true,
  value: function matches(
    this: CliEntrypointAdapter,
    params: { metaUrl: string; argvPath?: string },
  ) {
    return this.resource.matches(params);
  },
  writable: true,
});

export const CliEntrypointClass = CliEntrypointClassAdapter as unknown as CliEntrypointConstructor;
export const CliEntrypoint = CliEntrypointServiceDefault;

export function isCliEntrypoint(metaUrl: string, argvPath = process.argv[1]): boolean {
  return CliEntrypoint.matches({ metaUrl, argvPath });
}
