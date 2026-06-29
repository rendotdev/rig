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
    const result = await new ToolCreator({ homeDir: home }).create("hello");
    expect(result.files).toHaveLength(1);
    expect(result.id).toBe("hello.greet");

    const help = await new ToolHelpService({ homeDir: home }).render("hello", "greet");
    expect(help).toContain("Greet a person");
    expect(help).toContain("rig run hello greet");
    expect(help).toContain("type Query");
  });

  test("inspects command metadata as JSON", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("hello");
    const inspected = await new ToolInspector({ homeDir: home }).inspect("hello", "greet");
    expect(inspected).toMatchObject({
      tool: "hello",
      command: "greet",
      id: "hello.greet",
      sideEffects: "read",
      api: {
        style: "graphql-inspired",
        operation: "query",
      },
    });
  });

  test("runs a command and returns a success envelope", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("hello");
    const result = await new ToolRunner({ homeDir: home }).run("hello", "greet", {
      homeDir: home,
      input: '{"name":"Agent"}',
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: {
        hello: {
          greet: { message: "Hello, Agent!" },
        },
      },
      errors: [],
      extensions: {
        rig: {
          ok: true,
          tool: "hello",
          command: "greet",
          id: "hello.greet",
          path: ["hello", "greet"],
        },
      },
    });
  });

  test("returns an error envelope for invalid input", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("hello");
    const result = await new ToolRunner({ homeDir: home }).run("hello", "greet", {
      homeDir: home,
      input: '{"name":123}',
    });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      data: null,
      errors: [
        {
          message: "Invalid input.",
          path: ["hello", "greet"],
          extensions: { code: "VALIDATION_ERROR" },
        },
      ],
      extensions: {
        rig: {
          ok: false,
          tool: "hello",
          command: "greet",
          id: "hello.greet",
          path: ["hello", "greet"],
        },
      },
    });
  });
});
