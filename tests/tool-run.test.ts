import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCreator } from "../src/tools/create";
import { ToolHelpService } from "../src/tools/help";
import { ToolInspector } from "../src/tools/inspect";
import { ToolRunner } from "../src/tools/run";

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

describe("tool commands", () => {
  test("creates a starter tool with definition-owned examples", async () => {
    const home = await homes.create();
    const result = await new ToolCreator({ homeDir: home }).create("sample");
    expect(result.files).toHaveLength(1);
    expect(result.id).toBe("sample.example");

    const help = await new ToolHelpService({ homeDir: home }).render("sample", "example");
    expect(help).toContain("Pass custom text");
    expect(help).toContain("rig run sample example");
    expect(help).toContain("Input:");
    expect(help).toContain("Output:");
  });

  test("inspects command metadata as JSON", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const inspected = await new ToolInspector({ homeDir: home }).inspect("sample", "example");
    expect(inspected).toMatchObject({
      tool: "sample",
      command: "example",
      id: "sample.example",
      sideEffects: "read",
      run: "rig run sample example [args...]",
    });
  });

  test("runs a command and returns a success envelope", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["Agent"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Agent" },
      errors: [],
    });
  });

  test("returns an error envelope for invalid input", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      input: '{"text":123}',
    });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      data: null,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "Invalid input.",
        },
      ],
    });
  });
});
