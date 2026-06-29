import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigConfigStore } from "../src/config/config";
import { RigPaths } from "../src/config/paths";

class TestHomeStore {
  private readonly homes: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-test-home-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

const homes = new TestHomeStore();

afterEach(async () => {
  await homes.cleanup();
});

describe("config", () => {
  test("expands tilde paths", async () => {
    const home = await homes.create();
    expect(new RigPaths({ homeDir: home }).expandTilde("~/.rig/tools")).toBe(
      join(home, ".rig/tools"),
    );
  });

  test("creates first-run config and base registry in a temp home", async () => {
    const home = await homes.create();
    const paths = new RigPaths({ homeDir: home });
    const config = await new RigConfigStore({ homeDir: home }).ensure();
    expect(config.version).toBe(1);
    expect(existsSync(paths.configPath)).toBe(true);
    expect(existsSync(join(home, ".rig/tools"))).toBe(true);
    expect(existsSync(join(home, ".rig/tools/tsconfig.json"))).toBe(true);
    expect(existsSync(join(home, ".rig/runtime/sdk.ts"))).toBe(true);
    expect(existsSync(join(home, ".rig/runtime/globals.d.ts"))).toBe(true);
  });
});
