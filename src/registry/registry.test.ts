import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryConfigServiceClass } from "./registry";
import { ToolDiscoveryServiceClass } from "./discover";
import { ToolCreatorClass } from "../tools/create";
import { CurrentRigToolApiVersion } from "../tools/domain/tool-api";
import { ToolListServiceClass, ToolMetadataCacheClass } from "../tools/list";

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
    const service = new RegistryConfigServiceClass({ homeDir: home });
    const added = await service.add(registry);
    expect(added.customRegistries).toContain(registry);

    const removed = await service.remove(registry);
    expect(removed.customRegistries).not.toContain(registry);
  });

  test("preserves concurrent registry additions", async () => {
    const home = await homes.create();
    const registries = Array.from({ length: 12 }, (_, index) =>
      join(home, `project-tools-${index}`),
    );

    await Promise.all(
      registries.map((registry) => new RegistryConfigServiceClass({ homeDir: home }).add(registry)),
    );

    expect(
      (await new RegistryConfigServiceClass({ homeDir: home }).list()).customRegistries.toSorted(),
    ).toEqual(registries.toSorted());
  });

  test("discovers index.rig.tsx entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "view-tool");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8");

    const discovery = new ToolDiscoveryServiceClass({ homeDir: home });
    const tools = await discovery.discover();

    expect(tools).toMatchObject([
      {
        name: "view-tool",
        toolPath: join(toolDir, "index.rig.tsx"),
      },
    ]);
    expect(await discovery.find("view-tool")).toMatchObject({
      name: "view-tool",
      toolPath: join(toolDir, "index.rig.tsx"),
    });
  });

  test("rejects legacy tool.ts entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "legacy");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "tool.ts"), "export default {};\n", "utf8");

    const discovery = new ToolDiscoveryServiceClass({ homeDir: home });
    await expect(discovery.discover()).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
    await expect(discovery.find("legacy")).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
  });

  test("lists base tools and custom registries visible to a project path", async () => {
    const home = await homes.create();
    await new ToolCreatorClass({ homeDir: home }).create("base-visible");

    const project = join(home, "project");
    const custom = join(project, "rig-tools");
    const outside = join(home, "outside-tools");
    const registry = new RegistryConfigServiceClass({ homeDir: home });
    await mkdir(join(project, ".git"), { recursive: true });
    await registry.add(outside);
    await registry.add(custom);
    await mkdir(join(outside, "local-only"), { recursive: true });
    await mkdir(join(custom, "project-tool"), { recursive: true });
    await mkdir(join(custom, "many-fields"), { recursive: true });
    await mkdir(join(custom, "scalar-example"), { recursive: true });
    await mkdir(join(custom, "scalar-required"), { recursive: true });
    await writeFile(
      join(outside, "local-only", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "local-only",
  description: "Outside custom registry test tool.",
  commands: {
    example: rig.defineCommand({
      description: "Run outside tool.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
      "utf8",
    );
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

    const service = new ToolListServiceClass({ homeDir: home });
    const list = await service.list({ visibleFromPath: join(project, "AGENTS.md") });
    const rendered = service.renderPlain(list);

    expect(rendered).toContain("rig run base-visible.example text=example #");
    expect(rendered).toContain("rig run project-tool.see text=VALUE #");
    expect(rendered).toContain("rig run project-tool.none #");
    expect(rendered).toContain("rig run many-fields.pack --input");
    expect(rendered).toContain("rig run scalar-example.say 'two words'");
    expect(rendered).toContain("rig run scalar-example.count count=2");
    expect(rendered).toContain("rig run scalar-required.say #");
    expect(rendered).toContain("rig run local-only.example");
  });

  test("reuses serialized metadata until a tool entry changes", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "cached");
    const toolPath = join(toolDir, "index.rig.ts");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      toolPath,
      `export default (rig) => {
  globalThis.__rigMetadataLoads = (globalThis.__rigMetadataLoads ?? 0) + 1;
  const load = globalThis.__rigMetadataLoads;
  return rig.defineTool({
    name: "cached",
    description: "Cached metadata load " + load + ".",
    collections: {
      notes: { schema: rig.z.object({ title: rig.z.string() }) },
      optional: undefined,
    },
    commands: {
      read: rig.defineCommand({
        description: "Read cached metadata.",
        input: rig.z.object({}),
        output: rig.z.number(),
        run: () => load,
      }),
    },
  });
};\n`,
      "utf8",
    );

    const first = await new ToolListServiceClass({ homeDir: home }).list();
    const second = await new ToolListServiceClass({ homeDir: home }).list();
    expect(first.tools[0]?.description).toBe("Cached metadata load 1.");
    expect(first.tools[0]?.collections).toEqual([
      { name: "notes", hasSchema: true },
      { name: "optional", hasSchema: false },
    ]);
    expect(second.tools[0]?.description).toBe("Cached metadata load 1.");

    await writeFile(
      toolPath,
      (await readFile(toolPath, "utf8")).replace(
        'description: "Cached metadata load " + load + ".",',
        'description: "Updated metadata load " + load + ".",',
      ),
    );
    const updated = await new ToolListServiceClass({ homeDir: home }).list();
    expect(updated.tools[0]?.description).toBe("Updated metadata load 2.");
  });

  test("discards incompatible metadata cache documents", async () => {
    const incompatible = [
      [],
      { version: 2 },
      { version: 1, toolApiVersion: 999, entries: {} },
      { version: 1, toolApiVersion: CurrentRigToolApiVersion, entries: null },
    ];
    const results = await Promise.all(
      incompatible.map(async (value) => {
        const home = await homes.create();
        await mkdir(join(home, "rig"), { recursive: true });
        await writeFile(join(home, "rig", "tool-metadata.json"), JSON.stringify(value), "utf8");
        return new ToolMetadataCacheClass({ homeDir: home }).load([]);
      }),
    );
    expect(results).toEqual(incompatible.map(() => []));
  });

  test("renders plain list entries without embedded line breaks", async () => {
    const rendered = new ToolListServiceClass().renderPlain({
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
          collections: [],
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
    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const custom = join(home, "custom-tools");
    await new RegistryConfigServiceClass({ homeDir: home }).add(custom);
    await mkdir(join(custom, "sample"), { recursive: true });
    await writeFile(join(custom, "sample", "index.rig.ts"), "export default {};\n", "utf8");

    const discovery = new ToolDiscoveryServiceClass({ homeDir: home });
    await expect(discovery.discover()).rejects.toThrow("Duplicate tool name: sample");
    await expect(discovery.find("sample")).rejects.toThrow("Duplicate tool name: sample");
    await expect(discovery.find("../sample")).rejects.toThrow("Tool not found: ../sample");
  });

  test("returns no direct match for a file in the registry", async () => {
    const home = await homes.create();
    const toolsDir = join(home, "rig", "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, "plain-file"), "not a tool\n", "utf8");

    await expect(
      new ToolDiscoveryServiceClass({ homeDir: home }).find("plain-file"),
    ).rejects.toThrow("Tool not found: plain-file");
  });

  test("rejects multiple direct entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "multiple");
    await mkdir(toolDir, { recursive: true });
    await Promise.all([
      writeFile(join(toolDir, "index.rig.ts"), "export default {};\n", "utf8"),
      writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8"),
    ]);

    await expect(new ToolDiscoveryServiceClass({ homeDir: home }).find("multiple")).rejects.toThrow(
      "multiple Rig entry files",
    );
  });
});
