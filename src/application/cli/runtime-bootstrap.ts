import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
};

export class BunRuntimeBootstrapClass {
  private readonly packageRoot: string;
  private readonly spawn: BunRuntimeSpawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bunGlobal: BunRuntimeGlobalProvider;

  constructor(params: BunRuntimeBootstrapParams = {}, deps: BunRuntimeBootstrapDeps = {}) {
    this.packageRoot = params.packageRoot ?? rigPackageRoot.find(import.meta.url);
    this.spawn = deps.spawn ?? spawnSync;
    this.env = deps.env ?? process.env;
    this.bunGlobal =
      deps.bunGlobal ?? (() => (globalThis as typeof globalThis & { Bun?: unknown }).Bun);
  }

  run(metaUrl: string, argv: string[]): number | undefined {
    if (!this.shouldBootstrap()) return undefined;
    const bunPath = this.resolveBunPath();
    if (!bunPath) return undefined;
    const result = this.spawn(
      bunPath,
      [this.autoInstallFlag(), fileURLToPath(metaUrl), ...argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...this.env, RIG_BUN_BOOTSTRAPPED: "1" },
      },
    );
    return result.status ?? 1;
  }

  shouldBootstrap(): boolean {
    return (
      this.bunGlobal() === undefined &&
      this.env.RIG_BUN_BOOTSTRAPPED !== "1" &&
      this.env.RIG_DISABLE_BUN_BOOTSTRAP !== "1"
    );
  }

  resolveBunPath(): string | undefined {
    const configured = this.env.RIG_BUN_PATH;
    const candidates = [
      configured,
      join(this.packageRoot, "node_modules", "bun", "bin", "bun.exe"),
      join(this.packageRoot, "node_modules", ".bin", "bun"),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) => existsSync(candidate));
  }

  autoInstallFlag(): string {
    return "--install=fallback";
  }
}

export function isCliEntrypoint(metaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    const resolved = realpathSync(argvPath);
    return metaUrl === pathToFileURL(resolved).href;
  } catch {
    return metaUrl === pathToFileURL(argvPath).href;
  }
}

export { BunRuntimeBootstrapClass as BunRuntimeBootstrap };
