import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { defineService } from "../define";
import { RigPathsRepo, type PathOptions } from "../config/paths";
import { RigErrorClass } from "../errors/RigError";

export type DevLinkOptions = PathOptions & {
  repoRoot?: string;
  platform?: NodeJS.Platform;
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

type DevLinkPaths = Pick<RigPathsRepo, "homeDir" | "resolve">;

type ExistingShim = { exists: boolean; isRigDevShim: boolean; content: string };

function renderDevLinkResult(params: { status: DevLinkStatus }): string {
  const lines = [
    "Rig dev link is ready.",
    "",
    `Shim: ${params.status.shimPath}`,
    `Repo: ${params.status.repoRoot}`,
    `On PATH: ${params.status.binDirOnPath ? "yes" : "no"}`,
    "",
    "Try:",
    "  rig",
    "  rig list",
  ];

  if (!params.status.binDirOnPath) {
    lines.push("", `Add ${params.status.binDir} to PATH to run rig from any shell.`);
  }
  return lines.join("\n");
}

function renderDevUnlinkResult(params: { status: DevLinkStatus }): string {
  return ["Rig dev link removed.", "", `Shim: ${params.status.shimPath}`].join("\n");
}

/* v8 ignore next 4 -- Bun path is covered by distribution integration */
async function readTextFile(params: { path: string }): Promise<string> {
  if (typeof Bun !== "undefined") return await Bun.file(params.path).text();
  return await readFile(params.path, "utf8");
}

/* v8 ignore next 4 -- Bun path is covered by distribution integration */
async function writeTextFile(params: { path: string; content: string }): Promise<void> {
  if (typeof Bun !== "undefined") await Bun.write(params.path, params.content);
  else await writeFile(params.path, params.content, "utf8");
}

const DevLinkServiceDeps: {
  createPaths: (params: { homeDir?: string }) => DevLinkPaths;
  exists: (path: string) => boolean;
  chmod: (path: string, mode: number) => Promise<void>;
  lstat: (path: string) => Promise<{ isFile(): boolean }>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  readTextFile: (params: { path: string }) => Promise<string>;
  rm: (path: string, options: { force: true }) => Promise<void>;
  writeTextFile: (params: { path: string; content: string }) => Promise<void>;
  cwd: () => string;
  pathEnvironment: () => string;
  platform: () => NodeJS.Platform;
  delimiter: string;
  join: (...paths: string[]) => string;
  resolve: (...paths: string[]) => string;
} = {
  createPaths: function createPaths(params: { homeDir?: string }) {
    return new RigPathsRepo({
      params: {
        homeDir: params.homeDir,
        defaultBaseRegistryDirValue: "~/rig/tools",
        legacyDefaultBaseRegistryDirValue: "~/.rig/tools",
      },
      deps: {
        homedir,
        cwd: process.cwd.bind(process),
        dirname,
        isAbsolute,
        join,
        resolve,
      },
    });
  },
  exists: existsSync,
  chmod,
  lstat,
  mkdir,
  readTextFile,
  rm,
  writeTextFile,
  cwd: process.cwd.bind(process),
  pathEnvironment: function pathEnvironment() {
    return process.env.PATH ?? "";
  },
  platform: function platform() {
    return process.platform;
  },
  delimiter,
  join,
  resolve,
};

export class DevLinkService extends defineService({
  params: {
    marker: "Rig dev shim",
    unixShimName: "rig",
    windowsShimName: "rig.cmd",
    defaultBinDirectory: [".local", "bin"] as const,
  },
  deps: DevLinkServiceDeps,
}) {
  public create(params: { options?: DevLinkOptions }) {
    const config = this.params;
    const deps = this.deps;
    const options = params.options ?? {};
    const Paths = deps.createPaths({ homeDir: options.homeDir });
    const repoRootOverride = options.repoRoot;
    const platform = options.platform ?? deps.platform();

    function repoRoot(): string {
      const path = deps.resolve(repoRootOverride ?? deps.cwd());
      if (
        !deps.exists(deps.join(path, "package.json")) ||
        !deps.exists(deps.join(path, "src", "cli.ts"))
      ) {
        throw new RigErrorClass("DEV_LINK_ERROR", "Run dev link from the Rig repository root.", {
          repoRoot: path,
          expected: ["package.json", "src/cli.ts"],
        });
      }
      return path;
    }

    function binDirectory(pathValue?: string): string {
      return pathValue
        ? Paths.resolve({ pathValue })
        : deps.join(Paths.homeDir({}), ...config.defaultBinDirectory);
    }

    function shimPath(path: string): string {
      return deps.join(path, platform === "win32" ? config.windowsShimName : config.unixShimName);
    }

    function repoMarker(path: string): string {
      return platform === "win32" ? `RIG_DEV_REPO=${path}` : `RIG_DEV_REPO=${JSON.stringify(path)}`;
    }

    function shimSource(path: string): string {
      if (platform === "win32") {
        return `@echo off
rem Rig dev shim. Safe to overwrite with \`rig dev link\`.
set "RIG_DEV_REPO=${path}"
bun --install=fallback run "%RIG_DEV_REPO%\\src\\bin.ts" %*
`;
      }
      return `#!/bin/sh
# Rig dev shim. Safe to overwrite with \`rig dev link\`.
RIG_DEV_REPO=${JSON.stringify(path)}
exec bun --install=fallback run "$RIG_DEV_REPO/src/bin.ts" "$@"
`;
    }

    async function readExistingShim(path: string): Promise<ExistingShim> {
      if (!deps.exists(path)) return { exists: false, isRigDevShim: false, content: "" };
      const shimStatus = await deps.lstat(path);
      if (!shimStatus.isFile()) return { exists: true, isRigDevShim: false, content: "" };
      const content = await deps.readTextFile({ path });
      return {
        exists: true,
        isRigDevShim: content.includes(config.marker),
        content,
      };
    }

    function binDirOnPath(path: string): boolean {
      const entries = deps
        .pathEnvironment()
        .split(deps.delimiter)
        .map((entry) => deps.resolve(entry));
      return entries.includes(deps.resolve(path));
    }

    async function status(statusParams: {
      options?: DevLinkCommandOptions;
    }): Promise<DevLinkStatus> {
      const commandOptions = statusParams.options ?? {};
      const root = repoRoot();
      const binDir = binDirectory(commandOptions.binDir);
      const path = shimPath(binDir);
      const existing = await readExistingShim(path);
      return {
        repoRoot: root,
        binDir,
        shimPath: path,
        exists: existing.exists,
        isRigDevShim: existing.isRigDevShim,
        pointsToCurrentRepo: existing.content.includes(repoMarker(root)),
        binDirOnPath: binDirOnPath(binDir),
      };
    }

    async function link(linkParams: { options?: DevLinkCommandOptions }): Promise<DevLinkStatus> {
      const commandOptions = linkParams.options ?? {};
      const root = repoRoot();
      const binDir = binDirectory(commandOptions.binDir);
      const path = shimPath(binDir);
      const existing = await readExistingShim(path);

      if (existing.exists && !existing.isRigDevShim && !commandOptions.force) {
        throw new RigErrorClass("DEV_LINK_ERROR", `Refusing to overwrite existing file: ${path}`, {
          shimPath: path,
          hint: "Use --force to replace it.",
        });
      }

      await deps.mkdir(binDir, { recursive: true });
      await deps.writeTextFile({ path, content: shimSource(root) });
      if (platform !== "win32") await deps.chmod(path, 0o755);
      return await status({ options: commandOptions });
    }

    async function unlink(unlinkParams: {
      options?: DevLinkCommandOptions;
    }): Promise<DevLinkStatus> {
      const commandOptions = unlinkParams.options ?? {};
      const binDir = binDirectory(commandOptions.binDir);
      const path = shimPath(binDir);
      const existing = await readExistingShim(path);

      if (existing.exists && !existing.isRigDevShim && !commandOptions.force) {
        throw new RigErrorClass("DEV_LINK_ERROR", `Refusing to remove non-Rig dev shim: ${path}`, {
          shimPath: path,
          hint: "Use --force to remove it anyway.",
        });
      }

      if (existing.exists) await deps.rm(path, { force: true });
      return await status({ options: commandOptions });
    }

    return {
      link,
      unlink,
      status,
      renderLinkResult: renderDevLinkResult,
      renderUnlinkResult: renderDevUnlinkResult,
    };
  }
}

export const DevLink = new DevLinkService();

export type DevLinkServiceClass = {
  link(options?: DevLinkCommandOptions): Promise<DevLinkStatus>;
  unlink(options?: DevLinkCommandOptions): Promise<DevLinkStatus>;
  status(options?: DevLinkCommandOptions): Promise<DevLinkStatus>;
  renderLinkResult(status: DevLinkStatus): string;
  renderUnlinkResult(status: DevLinkStatus): string;
};

type DevLinkServiceConstructor = {
  new (options?: DevLinkOptions): DevLinkServiceClass;
  readonly prototype: DevLinkServiceClass;
};

type DevLinkResource = ReturnType<DevLinkService["create"]>;

type DevLinkAdapter = DevLinkServiceClass & { readonly resource: DevLinkResource };

const DevLinkServiceClassAdapter = function constructDevLinkService(
  this: DevLinkAdapter,
  options: DevLinkOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: DevLink.create({ options }),
  });
};
Object.defineProperty(DevLinkServiceClassAdapter, "name", { value: "DevLinkServiceClass" });
Object.defineProperties(DevLinkServiceClassAdapter.prototype, {
  link: {
    configurable: true,
    value: function link(this: DevLinkAdapter, options?: DevLinkCommandOptions) {
      return this.resource.link({ options });
    },
    writable: true,
  },
  unlink: {
    configurable: true,
    value: function unlink(this: DevLinkAdapter, options?: DevLinkCommandOptions) {
      return this.resource.unlink({ options });
    },
    writable: true,
  },
  status: {
    configurable: true,
    value: function status(this: DevLinkAdapter, options?: DevLinkCommandOptions) {
      return this.resource.status({ options });
    },
    writable: true,
  },
  renderLinkResult: {
    configurable: true,
    value: function renderLinkResult(this: DevLinkAdapter, status: DevLinkStatus) {
      return this.resource.renderLinkResult({ status });
    },
    writable: true,
  },
  renderUnlinkResult: {
    configurable: true,
    value: function renderUnlinkResult(this: DevLinkAdapter, status: DevLinkStatus) {
      return this.resource.renderUnlinkResult({ status });
    },
    writable: true,
  },
});

export const DevLinkServiceClass =
  DevLinkServiceClassAdapter as unknown as DevLinkServiceConstructor;
