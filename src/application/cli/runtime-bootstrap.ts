import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainClass } from "../../domain/domain-class";
import { rigPackageRoot } from "../../runtime/package-root";

type BunRuntimeSpawn = (
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<Buffer>;

type BunRuntimeGlobalProvider = () => unknown;

export type BunRuntimeBootstrapParams = {
  packageRoot?: string;
};

export type BunRuntimeBootstrapDeps = {
  spawn?: BunRuntimeSpawn;
  env?: NodeJS.ProcessEnv;
  bunGlobal?: BunRuntimeGlobalProvider;
  resolvePackage?: (specifier: string) => string;
};

export class BunRuntimeBootstrapClass extends DomainClass<
  BunRuntimeBootstrapParams,
  BunRuntimeBootstrapDeps
> {
  private readonly packageRoot: string;
  private readonly spawn: BunRuntimeSpawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bunGlobal: BunRuntimeGlobalProvider;
  private readonly resolvePackage: (specifier: string) => string;

  public constructor(params: BunRuntimeBootstrapParams, deps: BunRuntimeBootstrapDeps) {
    super(params, deps);
    this.packageRoot = this.params.packageRoot ?? rigPackageRoot.find(import.meta.url);
    this.spawn = this.deps.spawn ?? spawnSync;
    this.env = this.deps.env ?? process.env;
    this.bunGlobal =
      this.deps.bunGlobal ?? (() => (globalThis as typeof globalThis & { Bun?: unknown }).Bun);
    const require = createRequire(import.meta.url);
    this.resolvePackage = this.deps.resolvePackage ?? require.resolve.bind(require);
  }

  public run(params: { metaUrl: string; argv: string[] }): number | undefined {
    if (!this.shouldBootstrap()) return undefined;
    const bunPath = this.resolveBunPath();
    if (!bunPath) return undefined;
    const result = this.spawn(
      bunPath,
      [this.autoInstallFlag(), fileURLToPath(params.metaUrl), ...params.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...this.env, RIG_BUN_BOOTSTRAPPED: "1" },
      },
    );
    return result.status ?? 1;
  }

  public shouldBootstrap(): boolean {
    return (
      this.bunGlobal() === undefined &&
      this.env.RIG_BUN_BOOTSTRAPPED !== "1" &&
      this.env.RIG_DISABLE_BUN_BOOTSTRAP !== "1"
    );
  }

  public resolveBunPath(): string | undefined {
    const configured = this.env.RIG_BUN_PATH;
    const candidates = [
      configured,
      join(this.packageRoot, "node_modules", "bun", "bin", "bun.exe"),
      join(this.packageRoot, "node_modules", ".bin", "bun"),
      this.installedBunPath(),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) => existsSync(candidate));
  }

  public autoInstallFlag(): string {
    return "--install=fallback";
  }

  private installedBunPath(): string | undefined {
    try {
      return join(dirname(this.resolvePackage("bun/package.json")), "bin", "bun.exe");
    } catch {
      return undefined;
    }
  }
}

type CliEntrypointDeps = {
  realpath: typeof realpathSync;
  pathToFileUrl: typeof pathToFileURL;
};

export class CliEntrypointClass extends DomainClass<Record<string, never>, CliEntrypointDeps> {
  public constructor(params: Record<string, never>, deps: CliEntrypointDeps) {
    super(params, deps);
  }

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

export const CliEntrypoint = new CliEntrypointClass(
  {},
  { realpath: realpathSync, pathToFileUrl: pathToFileURL },
);

export function isCliEntrypoint(metaUrl: string, argvPath = process.argv[1]): boolean {
  return CliEntrypoint.matches({ metaUrl, argvPath });
}

export { BunRuntimeBootstrapClass as BunRuntimeBootstrap };
