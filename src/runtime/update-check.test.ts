import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigPathsClass } from "../config/paths";
import { NpmUpdateCheckServiceClass } from "./update-check";

class UpdateCheckWorkspaceStore {
  private readonly homes: string[] = [];
  private readonly originalEnv = { ...process.env };

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-update-check-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    process.env = { ...this.originalEnv };
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

const workspaces = new UpdateCheckWorkspaceStore();

afterEach(async () => {
  await workspaces.cleanup();
});

describe("npm update checks", () => {
  test("skips checks when disabled", async () => {
    const home = await workspaces.create();
    process.env.RIG_UPDATE_CHECK = "0";
    const service = new NpmUpdateCheckServiceClass({
      homeDir: home,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(service.check("0.0.3")).resolves.toBeUndefined();
  });

  test("fetches, caches, and renders newer npm versions", async () => {
    const home = await workspaces.create();
    const urls: string[] = [];
    const service = new NpmUpdateCheckServiceClass({
      homeDir: home,
      now: () => 1000,
      packageName: "@scope/tool",
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, json: async () => ({ version: "1.2.4" }) };
      },
    });

    const notice = await service.check("1.2.3");

    expect(urls).toEqual(["https://registry.npmjs.org/%40scope%2Ftool/latest"]);
    expect(notice).toMatchObject({
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      message: "Rig update available: @scope/tool 1.2.3 -> 1.2.4. Run npm install -g @scope/tool.",
    });
    expect(
      await readFile(new RigPathsClass({ homeDir: home }).updateCheckCachePath, "utf8"),
    ).toContain('"latestVersion": "1.2.4"');

    const cached = new NpmUpdateCheckServiceClass({
      homeDir: home,
      now: () => 1001,
      packageName: "@scope/tool",
      fetch: async () => {
        throw new Error("fresh cache should avoid fetch");
      },
    });
    await expect(cached.check("1.2")).resolves.toMatchObject({ latestVersion: "1.2.4" });
    await expect(cached.check("1.2.3")).resolves.toMatchObject({ latestVersion: "1.2.4" });
    await expect(cached.check("1.2.4")).resolves.toBeUndefined();
    await expect(cached.check("1.2.5")).resolves.toBeUndefined();

    await writeFile(
      new RigPathsClass({ homeDir: home }).updateCheckCachePath,
      '{"checkedAt": 1002,"latestVersion":"1.2"}\n',
      "utf8",
    );
    const shorter = new NpmUpdateCheckServiceClass({
      homeDir: home,
      now: () => 1003,
      packageName: "@scope/tool",
      fetch: async () => {
        throw new Error("fresh cache should avoid fetch");
      },
    });
    await expect(shorter.check("1.2.1")).resolves.toBeUndefined();
  });

  test("ignores stale cache misses and invalid registry data", async () => {
    const home = await workspaces.create();
    const paths = new RigPathsClass({ homeDir: home });
    await mkdir(paths.rigDir, { recursive: true });
    await writeFile(paths.updateCheckCachePath, '{"checkedAt": 1}\n', "utf8");

    const missing = new NpmUpdateCheckServiceClass({
      homeDir: home,
      now: () => 10_000_000,
      cacheTtlMs: 1,
      fetch: async () => ({ ok: false, json: async () => ({ version: "9.9.9" }) }),
    });
    await expect(missing.check("1.0.0")).resolves.toBeUndefined();

    const invalid = new NpmUpdateCheckServiceClass({
      homeDir: home,
      now: () => 10_000_000,
      cacheTtlMs: 1,
      fetch: async () => ({ ok: true, json: async () => ({ name: "rig" }) }),
    });
    await expect(invalid.check("1.0.0")).resolves.toBeUndefined();

    await writeFile(paths.updateCheckCachePath, "[]\n", "utf8");
    const invalidCache = new NpmUpdateCheckServiceClass({
      homeDir: home,
      fetch: async () => ({ ok: false, json: async () => ({}) }),
    });
    await expect(invalidCache.check("1.0.0")).resolves.toBeUndefined();
  });

  test("handles invalid cache files and fetch failures", async () => {
    const home = await workspaces.create();
    const paths = new RigPathsClass({ homeDir: home });
    await mkdir(paths.rigDir, { recursive: true });
    await writeFile(paths.updateCheckCachePath, "{ nope", "utf8");

    const throwing = new NpmUpdateCheckServiceClass({
      homeDir: home,
      fetch: async () => {
        throw new Error("network failed");
      },
    });
    await expect(throwing.check("1.0.0")).resolves.toBeUndefined();

    const aborted = new NpmUpdateCheckServiceClass({
      homeDir: home,
      timeoutMs: 1,
      fetch: async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(aborted.check("1.0.0")).resolves.toBeUndefined();
  });
});
