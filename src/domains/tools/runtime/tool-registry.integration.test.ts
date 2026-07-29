import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { rigConfigStoreLayer } from "../../settings/service/config-store";
import { atomicFileWriterLayer } from "../../../providers/filesystem/atomic-file-writer";
import {
  RigPathsConfigService,
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  RigPathsService,
} from "../../../providers/paths/rig-paths";
import { rigShellLayer } from "../../../providers/process/rig-shell-service";
import { RegistryService, registryLayer } from "../../registry/service/registry";
import { ToolDiscoveryService, toolDiscoveryLayer } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { CurrentRigToolApiVersion } from "../config/tool-api";
import { schemaRendererLayer } from "../service/schema-renderer";
import { toolDefinitionLayer } from "../service/tool-definition";
import { toolIdentifierLayer } from "../service/tool-identifier";
import { runtimeSupportRendererLayer } from "./runtime-support";
import { ToolFilesService } from "./tool-files";
import { toolEnvironmentLayer } from "./tool-environment";
import { toolLoaderLayer } from "./tool-loader";
import { rigToolKitLayer } from "./tool-sdk";
import {
  ToolListService,
  ToolMetadataCacheService,
  toolMetadataCacheLayer,
  type ToolListData,
} from "./tool-list";

const pathLayers = (homeDir: string) => {
  const options = Layer.succeed(RigPathsOptionsConfigService, { homeDir });
  const platform = RigPathsPlatformService.layer;
  const inputs = Layer.merge(options, platform);
  const config = RigPathsConfigService.layer.pipe(Layer.provide(inputs));
  const paths = RigPathsService.layer.pipe(Layer.provide(Layer.merge(config, platform)));
  return { inputs, config, paths, services: Layer.merge(config, paths) } as const;
};

const registryService = (homeDir: string) => {
  const paths = pathLayers(homeDir);
  const infrastructure = Layer.merge(
    atomicFileWriterLayer,
    runtimeSupportRendererLayer.pipe(Layer.provide(paths.config)),
  );
  const layer = registryLayer.pipe(Layer.provide(paths.inputs), Layer.provide(infrastructure));
  const run = <A, E>(effect: Effect.Effect<A, E, RegistryService>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return {
    list: () => run(RegistryService.use((service) => service.list)),
    add: (path: string) => run(RegistryService.use((service) => service.add(path))),
    remove: (path: string) => run(RegistryService.use((service) => service.remove(path))),
  } as const;
};

const discoveryService = (homeDir: string) => {
  const paths = pathLayers(homeDir);
  const infrastructure = Layer.merge(
    atomicFileWriterLayer,
    runtimeSupportRendererLayer.pipe(Layer.provide(paths.config)),
  );
  const registry = registryLayer.pipe(Layer.provide(paths.inputs), Layer.provide(infrastructure));
  const layer = toolDiscoveryLayer.pipe(Layer.provide(Layer.merge(registry, paths.services)));
  const run = <A, E>(effect: Effect.Effect<A, E, ToolDiscoveryService>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return {
    discover: () => run(ToolDiscoveryService.use((service) => service.discover())),
    find: (name: string) => run(ToolDiscoveryService.use((service) => service.find(name))),
    layer,
  } as const;
};

const toolServices = (homeDir: string) => {
  const paths = pathLayers(homeDir);
  const infrastructure = Layer.merge(
    atomicFileWriterLayer,
    runtimeSupportRendererLayer.pipe(Layer.provide(paths.config)),
  );
  const config = rigConfigStoreLayer.pipe(
    Layer.provide(paths.inputs),
    Layer.provide(infrastructure),
  );
  const registry = registryLayer.pipe(Layer.provide(paths.inputs), Layer.provide(infrastructure));
  const discovery = toolDiscoveryLayer.pipe(Layer.provide(Layer.merge(registry, paths.services)));
  const toolkit = rigToolKitLayer.pipe(
    Layer.provide(Layer.mergeAll(rigShellLayer, paths.config, paths.services)),
  );
  const loader = toolLoaderLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        toolEnvironmentLayer,
        discovery,
        toolDefinitionLayer,
        toolIdentifierLayer,
        toolkit,
      ),
    ),
  );
  const metadata = toolMetadataCacheLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        paths.config,
        loader,
        atomicFileWriterLayer,
        schemaRendererLayer,
        toolIdentifierLayer,
      ),
    ),
  );
  const files = ToolFilesService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(paths.services, config, discovery, atomicFileWriterLayer, toolDefinitionLayer),
    ),
  );
  const list = ToolListService.layer.pipe(
    Layer.provide(Layer.mergeAll(discovery, metadata, toolIdentifierLayer)),
  );
  return { discovery, files, list, metadata } as const;
};

const createTool = (homeDir: string, name: string) =>
  Effect.runPromise(
    ToolFilesService.use((service) => service.create(name)).pipe(
      Effect.provide(toolServices(homeDir).files),
    ),
  );

const toolListService = (homeDir: string) => {
  const layer = toolServices(homeDir).list;
  return {
    list: (options?: { visibleFromPath?: string }) =>
      Effect.runPromise(
        ToolListService.use((service) => service.list(options)).pipe(Effect.provide(layer)),
      ),
    renderPlain: (data: ToolListData) =>
      Effect.runPromise(
        ToolListService.use((service) => service.renderPlain(data)).pipe(Effect.provide(layer)),
      ),
  } as const;
};

const toolMetadataCacheService = (homeDir: string) => {
  const layer = toolServices(homeDir).metadata;
  return {
    load: (entries: DiscoveredTool[]) =>
      Effect.runPromise(
        ToolMetadataCacheService.use((service) => service.load(entries)).pipe(
          Effect.provide(layer),
        ),
      ),
  } as const;
};

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

const localOnlyToolSource = `export default (rig) => rig.defineTool({
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
`;

const projectToolSource = `export default (rig) => rig.defineTool({
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
`;

const manyFieldsToolSource = `export default (rig) => rig.defineTool({
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
`;

const scalarExampleToolSource = `export default (rig) => rig.defineTool({
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
`;

const scalarRequiredToolSource = `export default (rig) => rig.defineTool({
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
`;

const writeToolEntry = async (registryPath: string, name: string, source: string) => {
  const toolDir = join(registryPath, name);
  await mkdir(toolDir, { recursive: true });
  await writeFile(join(toolDir, "index.rig.ts"), source, "utf8");
};

const createVisibilityFixture = async (home: string) => {
  const project = join(home, "project");
  const custom = join(project, "rig-tools");
  const outside = join(home, "outside-tools");
  const registry = registryService(home);
  await mkdir(join(project, ".git"), { recursive: true });
  await registry.add(outside);
  await registry.add(custom);
  await Promise.all([
    writeToolEntry(outside, "local-only", localOnlyToolSource),
    writeToolEntry(custom, "project-tool", projectToolSource),
    writeToolEntry(custom, "many-fields", manyFieldsToolSource),
    writeToolEntry(custom, "scalar-example", scalarExampleToolSource),
    writeToolEntry(custom, "scalar-required", scalarRequiredToolSource),
  ]);
  return project;
};

const expectVisibleToolCommands = (rendered: string) => {
  expect(rendered).toContain("rig run base-visible.example text=example #");
  expect(rendered).toContain("rig run project-tool.see text=VALUE #");
  expect(rendered).toContain("rig run project-tool.none #");
  expect(rendered).toContain("rig run many-fields.pack --input");
  expect(rendered).toContain("rig run scalar-example.say 'two words'");
  expect(rendered).toContain("rig run scalar-example.count count=2");
  expect(rendered).toContain("rig run scalar-required.say #");
  expect(rendered).toContain("rig run local-only.example");
};

afterEach(async () => {
  await homes.cleanup();
});

describe("registries", () => {
  test("adds and removes a custom registry", async () => {
    const home = await homes.create();
    const registry = join(home, "project-tools");
    const service = registryService(home);
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

    await Promise.all(registries.map((registry) => registryService(home).add(registry)));

    expect((await registryService(home).list()).customRegistries.toSorted()).toEqual(
      registries.toSorted(),
    );
  });

  test("discovers index.rig.tsx entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "view-tool");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8");

    const discovery = discoveryService(home);
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

    const discovery = discoveryService(home);
    await expect(discovery.discover()).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
    await expect(discovery.find("legacy")).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
  });

  test("lists base tools and custom registries visible to a project path", async () => {
    expect.assertions(8);
    const home = await homes.create();
    await createTool(home, "base-visible");
    const project = await createVisibilityFixture(home);
    const service = toolListService(home);
    const list = await service.list({ visibleFromPath: join(project, "AGENTS.md") });
    const rendered = await service.renderPlain(list);
    expectVisibleToolCommands(rendered);
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

    const first = await toolListService(home).list();
    const second = await toolListService(home).list();
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
    const updated = await toolListService(home).list();
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
        return toolMetadataCacheService(home).load([]);
      }),
    );
    expect(results).toEqual(incompatible.map(() => []));
  });

  test("renders plain list entries without embedded line breaks", async () => {
    const rendered = await toolListService(process.cwd()).renderPlain({
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
    await createTool(home, "sample");
    const custom = join(home, "custom-tools");
    await registryService(home).add(custom);
    await mkdir(join(custom, "sample"), { recursive: true });
    await writeFile(join(custom, "sample", "index.rig.ts"), "export default {};\n", "utf8");

    const discovery = discoveryService(home);
    await expect(discovery.discover()).rejects.toThrow("Duplicate tool name: sample");
    await expect(discovery.find("sample")).rejects.toThrow("Duplicate tool name: sample");
    await expect(discovery.find("../sample")).rejects.toThrow("Tool not found: ../sample");
  });

  test("returns no direct match for a file in the registry", async () => {
    const home = await homes.create();
    const toolsDir = join(home, "rig", "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, "plain-file"), "not a tool\n", "utf8");

    await expect(discoveryService(home).find("plain-file")).rejects.toThrow(
      "Tool not found: plain-file",
    );
  });

  test("rejects multiple direct entry files", async () => {
    const home = await homes.create();
    const toolDir = join(home, "rig", "tools", "multiple");
    await mkdir(toolDir, { recursive: true });
    await Promise.all([
      writeFile(join(toolDir, "index.rig.ts"), "export default {};\n", "utf8"),
      writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8"),
    ]);

    await expect(discoveryService(home).find("multiple")).rejects.toThrow(
      "multiple Rig entry files",
    );
  });
});
