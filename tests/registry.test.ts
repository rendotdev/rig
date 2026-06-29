import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryConfigService } from "../src/registry/registry";
import { ToolDiscoveryService } from "../src/registry/discover";
import { ToolCreator } from "../src/tools/create";

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

describe("registries", () => {
  test("adds and removes a custom registry", async () => {
    const home = await homes.create();
    const registry = join(home, "project-tools");
    const service = new RegistryConfigService({ homeDir: home });
    const added = await service.add(registry);
    expect(added.customRegistries).toContain(registry);

    const removed = await service.remove(registry);
    expect(removed.customRegistries).not.toContain(registry);
  });

  test("detects duplicate tool names across registries", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const custom = join(home, "custom-tools");
    await new RegistryConfigService({ homeDir: home }).add(custom);
    await mkdir(join(custom, "sample"), { recursive: true });
    await writeFile(join(custom, "sample", "tool.ts"), "export default {};\n", "utf8");

    await expect(new ToolDiscoveryService({ homeDir: home }).discover()).rejects.toThrow(
      "Duplicate tool name: sample",
    );
  });
});
