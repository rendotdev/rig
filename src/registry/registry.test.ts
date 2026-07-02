import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryConfigService } from "./registry";
import { ToolDiscoveryService } from "./discover";
import { ToolCreator } from "../tools/create";
import { ToolListService } from "../tools/list";

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

  test("discovers index.rig.tsx entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "view-tool");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8");

    const tools = await new ToolDiscoveryService({ homeDir: home }).discover();

    expect(tools).toMatchObject([
      {
        name: "view-tool",
        toolPath: join(toolDir, "index.rig.tsx"),
      },
    ]);
  });

  test("rejects legacy tool.ts entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "legacy");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "tool.ts"), "export default {};\n", "utf8");

    await expect(new ToolDiscoveryService({ homeDir: home }).discover()).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
  });

  test("lists tools from registries visible to a project path", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("local-only");

    const project = join(home, "project");
    const custom = join(project, "rig-tools");
    await mkdir(join(project, ".git"), { recursive: true });
    await new RegistryConfigService({ homeDir: home }).add(custom);
    await mkdir(join(custom, "project-tool"), { recursive: true });
    await mkdir(join(custom, "many-fields"), { recursive: true });
    await mkdir(join(custom, "scalar-example"), { recursive: true });
    await mkdir(join(custom, "scalar-required"), { recursive: true });
    await writeFile(
      join(custom, "project-tool", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "project-tool",
  description: "Project visible test tool.",
  commands: {
    see: rig.defineCommand({
      description: "See the project tool.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => ({ text: context.input.text }),
    }),
    none: rig.defineCommand({
      description: "Run without required input.",
      input: rig.z.object({ optional: rig.z.string().optional() }),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
      "utf8",
    );
    await writeFile(
      join(custom, "many-fields", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "many-fields",
  description: "Many fields test tool.",
  commands: {
    pack: rig.defineCommand({
      description: "Pack many required fields.",
      input: rig.z.object({
        text: rig.z.string(),
        count: rig.z.number(),
        enabled: rig.z.boolean(),
        tags: rig.z.array(rig.z.string()),
        meta: rig.z.object({}),
        maybe: rig.z.string().nullable(),
      }),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
      "utf8",
    );
    await writeFile(
      join(custom, "scalar-example", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "scalar-example",
  description: "Scalar example test tool.",
  commands: {
    say: rig.defineCommand({
      description: "Say scalar text.",
      input: rig.z.object(rig.z.string()),
      output: rig.z.object({ text: rig.z.string() }),
      examples: [{ title: "Say hello", text: "Say hello.", input: "two words" }],
      run: async (context) => ({ text: context.input }),
    }),
    count: rig.defineCommand({
      description: "Count with an example.",
      input: rig.z.object({ count: rig.z.number() }),
      output: rig.z.object({ count: rig.z.number() }),
      examples: [{ title: "Count", text: "Count.", input: { count: 2 } }],
      run: async (context) => ({ count: context.input.count }),
    }),
  },
});
`,
      "utf8",
    );
    await writeFile(
      join(custom, "scalar-required", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "scalar-required",
  description: "Scalar required test tool.",
  commands: {
    say: rig.defineCommand({
      description: "Say required scalar text.",
      input: rig.z.object(rig.z.string()),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => ({ text: context.input }),
    }),
  },
});
`,
      "utf8",
    );

    const service = new ToolListService({ homeDir: home });
    const list = await service.list({ visibleFromPath: join(project, "AGENTS.md") });
    const rendered = service.renderPlain(list);

    expect(rendered).toContain("rig run project-tool.see text=VALUE #");
    expect(rendered).toContain("rig run project-tool.none #");
    expect(rendered).toContain("rig run many-fields.pack --input");
    expect(rendered).toContain("rig run scalar-example.say 'two words'");
    expect(rendered).toContain("rig run scalar-example.count count=2");
    expect(rendered).toContain("rig run scalar-required.say #");
    expect(rendered).not.toContain("rig run local-only.example");
  });

  test("renders plain list entries without embedded line breaks", async () => {
    const rendered = new ToolListService().renderPlain({
      tools: [
        {
          name: "wrapped",
          description: "First line\n\nsecond\tline.",
          registryKind: "base",
          registryPath: "/tmp/registry",
          toolPath: "/tmp/registry/wrapped/index.rig.ts",
          commands: [
            {
              name: "say",
              id: "wrapped.say",
              description: "Command line\r\ncontinues.",
              runExample: "rig run wrapped.say text='hello\nworld'",
              helpExample: "rig help wrapped.say",
            },
          ],
        },
      ],
    });

    expect(rendered.split("\n")).toEqual([
      "wrapped # First line second line.",
      "  rig run wrapped.say text='hello\\nworld' # Command line continues.",
    ]);
  });

  test("detects duplicate tool names across registries", async () => {
    const home = await homes.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const custom = join(home, "custom-tools");
    await new RegistryConfigService({ homeDir: home }).add(custom);
    await mkdir(join(custom, "sample"), { recursive: true });
    await writeFile(join(custom, "sample", "index.rig.ts"), "export default {};\n", "utf8");

    await expect(new ToolDiscoveryService({ homeDir: home }).discover()).rejects.toThrow(
      "Duplicate tool name: sample",
    );
  });
});
