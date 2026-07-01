import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RigPaths, type PathOptions } from "../config/paths";
import { RigError } from "../errors/RigError";

export type DevLinkOptions = PathOptions & {
  repoRoot?: string;
};

export type DevLinkCommandOptions = {
  binDir?: string;
  force?: boolean;
};

export type DevLinkStatus = {
  repoRoot: string;
  binDir: string;
  shimPath: string;
  exists: boolean;
  isRigDevShim: boolean;
  pointsToCurrentRepo: boolean;
  binDirOnPath: boolean;
};

export class DevLinkService {
  private readonly paths: RigPaths;
  private readonly repoRootOverride?: string;

  constructor(options: DevLinkOptions = {}) {
    this.paths = new RigPaths(options);
    this.repoRootOverride = options.repoRoot;
  }

  async link(options: DevLinkCommandOptions = {}): Promise<DevLinkStatus> {
    const repoRoot = this.repoRoot();
    const binDir = this.binDir(options.binDir);
    const shimPath = join(binDir, "rig");
    const existing = await this.readExistingShim(shimPath);

    if (existing.exists && !existing.isRigDevShim && !options.force) {
      throw new RigError("DEV_LINK_ERROR", `Refusing to overwrite existing file: ${shimPath}`, {
        shimPath,
        hint: "Use --force to replace it.",
      });
    }

    await mkdir(binDir, { recursive: true });
    /* v8 ignore next 3 */
    if (typeof Bun !== "undefined") await Bun.write(shimPath, this.shimSource(repoRoot));
    else await writeFile(shimPath, this.shimSource(repoRoot), "utf8");
    await chmod(shimPath, 0o755);
    return this.status(options);
  }

  async unlink(options: DevLinkCommandOptions = {}): Promise<DevLinkStatus> {
    const binDir = this.binDir(options.binDir);
    const shimPath = join(binDir, "rig");
    const existing = await this.readExistingShim(shimPath);

    if (existing.exists && !existing.isRigDevShim && !options.force) {
      throw new RigError("DEV_LINK_ERROR", `Refusing to remove non-Rig dev shim: ${shimPath}`, {
        shimPath,
        hint: "Use --force to remove it anyway.",
      });
    }

    if (existing.exists) {
      await rm(shimPath, { force: true });
    }

    return this.status(options);
  }

  async status(options: DevLinkCommandOptions = {}): Promise<DevLinkStatus> {
    const repoRoot = this.repoRoot();
    const binDir = this.binDir(options.binDir);
    const shimPath = join(binDir, "rig");
    const existing = await this.readExistingShim(shimPath);
    return {
      repoRoot,
      binDir,
      shimPath,
      exists: existing.exists,
      isRigDevShim: existing.isRigDevShim,
      pointsToCurrentRepo: existing.content.includes(`RIG_DEV_REPO=${JSON.stringify(repoRoot)}`),
      binDirOnPath: this.binDirOnPath(binDir),
    };
  }

  renderLinkResult(status: DevLinkStatus): string {
    const lines = [
      "Rig dev link is ready.",
      "",
      `Shim: ${status.shimPath}`,
      `Repo: ${status.repoRoot}`,
      `On PATH: ${status.binDirOnPath ? "yes" : "no"}`,
      "",
      "Try:",
      "  rig",
      "  rig list",
    ];

    if (!status.binDirOnPath) {
      lines.push("", `Add ${status.binDir} to PATH to run rig from any shell.`);
    }

    return lines.join("\n");
  }

  renderUnlinkResult(status: DevLinkStatus): string {
    return [`Rig dev link removed.`, "", `Shim: ${status.shimPath}`].join("\n");
  }

  private repoRoot(): string {
    const repoRoot = resolve(this.repoRootOverride ?? process.cwd());
    if (
      !existsSync(join(repoRoot, "package.json")) ||
      !existsSync(join(repoRoot, "src", "cli.ts"))
    ) {
      throw new RigError("DEV_LINK_ERROR", "Run dev link from the Rig repository root.", {
        repoRoot,
        expected: ["package.json", "src/cli.ts"],
      });
    }
    return repoRoot;
  }

  private binDir(pathValue?: string): string {
    return pathValue ? this.paths.resolve(pathValue) : join(this.paths.homeDir, ".local", "bin");
  }

  private shimSource(repoRoot: string): string {
    return `#!/usr/bin/env bash
# Rig dev shim. Safe to overwrite with \`rig dev link\`.
RIG_DEV_REPO=${JSON.stringify(repoRoot)}
exec bun --install=fallback run "$RIG_DEV_REPO/src/cli.ts" "$@"
`;
  }

  private async readExistingShim(
    shimPath: string,
  ): Promise<{ exists: boolean; isRigDevShim: boolean; content: string }> {
    if (!existsSync(shimPath)) return { exists: false, isRigDevShim: false, content: "" };
    const stat = await lstat(shimPath);
    if (!stat.isFile()) return { exists: true, isRigDevShim: false, content: "" };
    /* v8 ignore next 2 */
    const content =
      typeof Bun !== "undefined"
        ? await Bun.file(shimPath).text()
        : await readFile(shimPath, "utf8");
    return {
      exists: true,
      isRigDevShim: content.includes("Rig dev shim"),
      content,
    };
  }

  private binDirOnPath(binDir: string): boolean {
    const entries = (process.env.PATH ?? "").split(":").map((entry) => resolve(entry));
    return entries.includes(resolve(binDir));
  }
}
