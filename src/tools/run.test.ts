import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCreator } from "./create";
import { ToolHelpService } from "./help";
import { ToolInspector } from "./inspect";
import { ToolListService } from "./list";
import { ToolRunner } from "./run";
import { ToolTypecheckService } from "./typecheck";

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
    expect(result.toolPath).toBe(join(home, ".rig", "tools", "sample", "index.rig.ts"));
    expect(result.id).toBe("sample.example");

    const help = await new ToolHelpService({ homeDir: home }).render("sample", "example");
    const commandIdHelp = await new ToolHelpService({ homeDir: home }).render("sample.example");
    expect(commandIdHelp).toMatch(
      /^Tool: sample\nCommand: example\nRun: rig run sample\.example \[args\.\.\.\]/,
    );
    expect(commandIdHelp).not.toContain("```bash");
    expect(help).toContain("Pass custom text");
    expect(help).toContain("rig run sample.example");
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
      run: "rig run sample.example [args...]",
    });
  });

  test("type-checks generated tools with injected Rig runtime types", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const result = await new ToolTypecheckService({ homeDir: home }).typecheck("sample");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.checked).toHaveLength(1);
  });

  test("type-checks command output against output schemas", async () => {
    const home = await homes.create();
    const toolDir = join(home, ".rig", "tools", "bad-output");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: "bad-output",
  description: "Bad output test tool.",
  commands: {
    example: rig.defineCommand({
      description: "Return the wrong output type.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async ({ input }) => ({ text: 123 }),
    }),
  },
});

export default tool;
`,
      "utf8",
    );

    const result = await new ToolTypecheckService({ homeDir: home }).typecheck("bad-output");

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
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

  test("runs registered tools from a tool context", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, ".rig", "tools", "caller");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "caller",
  description: "Tool runner test tool.",
  commands: {
    call: rig.defineCommand({
      description: "Call another Rig tool.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => {
        const result = await context.rig.run({
          command: "sample.example",
          input: { text: context.input.text },
        });
        return { text: result.text };
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("caller", "call", {
      homeDir: home,
      input: '{"text":"Nested"}',
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Nested" },
      errors: [],
    });
  });

  test("renders a compact plain command list", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const service = new ToolListService({ homeDir: home });
    const list = await service.list();

    const rendered = service.renderPlain(list);
    expect(rendered).toContain("sample.example text=example #");
  });

  test("dry-runs a command without execution", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, ".rig", "tools", "writer");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "writer",
  description: "Writer test tool.",
  commands: {
    save: rig.defineCommand({
      description: "Save text.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => {
        throw new Error("dry-run should not execute command code");
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("writer", "save", {
      homeDir: home,
      args: ["text=Agent"],
      dryRun: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: {
        dryRun: true,
        wouldRun: false,
        id: "writer.save",
        input: { text: "Agent" },
      },
      errors: [],
    });
  });

  test("truncates large command output and saves the full data to a temp file", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const toolDir = join(home, ".rig", "tools", "large");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "large",
  description: "Large output test tool.",
  commands: {
    dump: rig.defineCommand({
      description: "Dump large text.",
      input: rig.z.object({}),
      output: rig.z.object({ text: rig.z.string() }),
      run: async () => ({ text: "x".repeat(60 * 1024) }),
    }),
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("large", "dump", {
      homeDir: home,
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: {
        truncated: true,
        previewFormat: "partial-json",
        fullOutputFormat: "json",
        totalBytes: expect.any(Number),
        shownBytes: expect.any(Number),
      },
      errors: [],
    });

    const envelope = result.envelope as { data: { fullOutputPath: string } };
    const fullOutput = await readFile(envelope.data.fullOutputPath, "utf8");
    expect(fullOutput).toContain('"text"');
    expect(fullOutput.length).toBeGreaterThan(60 * 1024);
  });

  test("accepts raw Zod schemas without rig.input/output wrappers", async () => {
    const home = await homes.create();
    const toolDir = join(home, ".rig", "tools", "raw-schema");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `import { RigTool, z } from "../../runtime/sdk";

export default RigTool.define({
  name: "raw-schema",
  description: "Raw schema test tool.",
  commands: {
    echo: {
      description: "Echo using raw z.object.",
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      run: async ({ input }) => ({ text: input.text }),
    },
  },
});
`,
      "utf8",
    );

    const result = await new ToolRunner({ homeDir: home }).run("raw-schema", "echo", {
      homeDir: home,
      input: '{"text":"Agent"}',
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
          details: {
            issues: [
              {
                path: "text",
                message: expect.any(String),
              },
            ],
          },
        },
      ],
    });
  });
});
