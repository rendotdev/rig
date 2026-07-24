import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevLink, DevLinkService, DevLinkServiceClass } from "./dev-link";

class TestWorkspaceStore {
  private readonly paths: string[] = [];

  async create(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-test-workspace-"));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

class TestRigRepo {
  constructor(readonly path: string) {}

  async create(): Promise<void> {
    await mkdir(join(this.path, "src"), { recursive: true });
    await writeFile(join(this.path, "package.json"), '{"name":"rig"}\n', "utf8");
    await writeFile(join(this.path, "src", "cli.ts"), "console.log('rig dev');\n", "utf8");
  }
}

const workspaces = new TestWorkspaceStore();

afterEach(async () => {
  await workspaces.cleanup();
});

describe("dev link", () => {
  test("links and unlinks a rig dev shim", async () => {
    const home = await workspaces.create();
    const repoPath = await workspaces.create();
    await new TestRigRepo(repoPath).create();

    const service = new DevLinkServiceClass({ homeDir: home, repoRoot: repoPath });
    const linked = await service.link();

    expect(linked.exists).toBe(true);
    expect(linked.isRigDevShim).toBe(true);
    expect(linked.pointsToCurrentRepo).toBe(true);
    expect(existsSync(linked.shimPath)).toBe(true);
    const shim = await readFile(linked.shimPath, "utf8");
    expect(shim).toContain("Rig dev shim");
    expect(shim).toContain("bun --install=fallback run");

    const unlinked = await service.unlink();
    expect(unlinked.exists).toBe(false);
    expect(existsSync(linked.shimPath)).toBe(false);
  });

  test("refuses to overwrite a non-Rig shim without force", async () => {
    const home = await workspaces.create();
    const repoPath = await workspaces.create();
    await new TestRigRepo(repoPath).create();
    const binDir = join(home, ".local", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rig"), "#!/usr/bin/env bash\necho nope\n", "utf8");

    await expect(
      new DevLinkServiceClass({ homeDir: home, repoRoot: repoPath }).link(),
    ).rejects.toThrow("Refusing to overwrite existing file");
  });

  test("builds replaceable resources and renders link results", () => {
    expect(DevLink.create({})).toBeDefined();

    const Service = new DevLinkService({
      params: {
        marker: "Rig dev shim",
        unixShimName: "rig",
        windowsShimName: "rig.cmd",
        defaultBinDirectory: [".local", "bin"],
      },
      deps: {
        createPaths() {
          return {
            homeDir() {
              return "/home/rig";
            },
            resolve(params) {
              return params.pathValue;
            },
          };
        },
        exists() {
          return true;
        },
        async chmod() {},
        async lstat() {
          return { isFile: () => true };
        },
        async mkdir() {},
        async readTextFile() {
          return "";
        },
        async rm() {},
        async writeTextFile() {},
        cwd() {
          return "/repo";
        },
        pathEnvironment() {
          return "/bin";
        },
        platform() {
          return "linux";
        },
        delimiter: ":",
        join(...paths) {
          return paths.join("/");
        },
        resolve(...paths) {
          return paths.at(-1) ?? "";
        },
      },
    });
    const service = Service.create({ options: { repoRoot: "/repo" } });
    const status = {
      repoRoot: "/repo",
      binDir: "/home/rig/.local/bin",
      shimPath: "/home/rig/.local/bin/rig",
      exists: true,
      isRigDevShim: true,
      pointsToCurrentRepo: true,
      binDirOnPath: false,
    };

    expect(service.renderLinkResult({ status })).toContain("Add /home/rig/.local/bin to PATH");
    expect(service.renderLinkResult({ status: { ...status, binDirOnPath: true } })).not.toContain(
      "Add /home/rig/.local/bin to PATH",
    );
    expect(service.renderUnlinkResult({ status })).toContain("Rig dev link removed.");
  });

  test("writes a Windows command shim when requested", async () => {
    const home = await workspaces.create();
    const repoPath = await workspaces.create();
    await new TestRigRepo(repoPath).create();

    const service = new DevLinkServiceClass({
      homeDir: home,
      repoRoot: repoPath,
      platform: "win32",
    });
    const linked = await service.link();
    const shim = await readFile(linked.shimPath, "utf8");

    expect(linked.shimPath).toBe(join(home, ".local", "bin", "rig.cmd"));
    expect(linked.pointsToCurrentRepo).toBe(true);
    expect(shim).toContain("@echo off");
    expect(shim).toContain('set "RIG_DEV_REPO=');
    expect(shim).toContain('run "%RIG_DEV_REPO%\\src\\bin.ts" %*');
  });
});
