import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { atomicFileWriterLayer } from "../../../providers/filesystem/atomic-file-writer";
import { RigPathsConfigService } from "../../../providers/paths/rig-paths";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { toolIdentifierLayer } from "../service/tool-identifier";
import { schemaRendererLayer } from "../service/schema-renderer";
import { toolSearchLayer } from "../service/tool-search";
import { toolDefinitionLayer } from "../service/tool-definition";
import { toolEnvironmentLayer } from "./tool-environment";
import { toolLoaderLayer } from "./tool-loader";
import { createRigToolKit, RigToolKitService } from "./tool-sdk";
import {
  ToolFindService,
  toolFindLayer,
  type ToolFindData,
  type ToolFindOptions,
} from "./tool-find";
import { toolMetadataCacheLayer } from "./tool-list";

class ToolFindTestHome {
  private readonly paths: string[] = [];

  public async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-find-test-"));
    this.paths.push(home);
    await this.writeTool({
      home,
      name: "languagetool",
      source: `export default (rig) => rig.defineTool({
  name: "languagetool",
  description: "Check grammar, spelling, and writing style.",
  commands: {
    "check-file": rig.defineCommand({
      description: "Check grammar and spelling in a local Markdown file.",
      input: rig.z.object({ input: rig.z.string().describe("Markdown file path") }),
      output: rig.z.object({ issues: rig.z.number() }),
      examples: [{
        title: "Proofread notes",
        text: "Check a Markdown document for writing problems.",
        input: { input: "notes.md" },
        output: { issues: 0 },
      }],
      run: async () => ({ issues: 0 }),
    }),
    "check-text": rig.defineCommand({
      description: "Check a text string.",
      input: rig.z.object({
        text: rig.z.string(),
        categories: rig.z.array(rig.z.enum(["grammar", "style"]).describe("Rule category")),
        strict: rig.z.boolean().optional(),
        maxIssues: rig.z.number().optional(),
      }),
      output: rig.z.object({ issues: rig.z.number() }),
      examples: [
        { title: "Default check", text: "Check without explicit input." },
        {
          title: "Configured check",
          text: "Check selected categories.",
          input: { text: "Hello", categories: ["grammar"], strict: true, maxIssues: 2, extra: null },
          output: { issues: 0 },
        },
      ],
      run: async () => ({ issues: 0 }),
    }),
  },
});`,
    });
    await this.writeTool({
      home,
      name: "image",
      source: `export default (rig) => rig.defineTool({
  name: "image",
  description: "Resize and convert images.",
  commands: {
    convert: rig.defineCommand({
      description: "Resize an image and convert its format.",
      input: rig.z.object({ input: rig.z.string(), width: rig.z.number().optional() }),
      output: rig.z.object({ output: rig.z.string() }),
      run: async () => ({ output: "image.webp" }),
    }),
  },
});`,
    });
    return home;
  }

  public async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }

  private async writeTool(params: { home: string; name: string; source: string }): Promise<void> {
    const directory = join(params.home, "rig", "tools", params.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.rig.ts"), params.source, "utf8");
  }
}

const findService = (home: string) => {
  const tools = ["languagetool", "image"].map(
    (name) =>
      ({
        name,
        registryKind: "base" as const,
        registryPath: join(home, "rig", "tools"),
        toolDir: join(home, "rig", "tools", name),
        toolPath: join(home, "rig", "tools", name, "index.rig.ts"),
      }) satisfies DiscoveredTool,
  );
  const discoveryLayer = Layer.succeed(ToolDiscoveryService, {
    discover: () => Effect.succeed(tools),
    discoverRegistry: () => Effect.succeed(tools),
    find: (name: string) => Effect.succeed(tools.find((tool) => tool.name === name)!),
    projectRootFor: () => Effect.succeed(home),
  });
  const toolkitLayer = Layer.succeed(RigToolKitService, {
    create: () => Effect.succeed(createRigToolKit({ homeDir: home })),
  });
  const loaderLayer = toolLoaderLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        toolEnvironmentLayer,
        discoveryLayer,
        toolDefinitionLayer,
        toolIdentifierLayer,
        toolkitLayer,
      ),
    ),
  );
  const pathLayer = Layer.succeed(RigPathsConfigService, {
    homeDir: home,
    rigDir: join(home, "rig"),
    legacyRigDir: join(home, ".rig"),
    configPath: join(home, "rig", "rig.json"),
    runtimeDir: join(home, "rig", "runtime"),
    runtimeSdkPath: join(home, "rig", "runtime", "sdk.ts"),
    runtimeTypesPath: join(home, "rig", "runtime", "types.d.ts"),
    runtimeGlobalsPath: join(home, "rig", "runtime", "globals.d.ts"),
    runtimeToolTsconfigPath: join(home, "rig", "runtime", "tsconfig.tools.json"),
    cronDir: join(home, "rig", "cron"),
    logsDir: join(home, "rig", ".logs"),
    updateCheckCachePath: join(home, "rig", "update-check.json"),
    toolMetadataCachePath: join(home, "rig", "tool-metadata.json"),
    migrationPromptStatePath: join(home, "rig", "migration-prompts.json"),
    defaultBaseRegistryDir: "~/rig/tools",
    legacyDefaultBaseRegistryDir: "~/.rig/tools",
  });
  const metadataLayer = toolMetadataCacheLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        loaderLayer,
        atomicFileWriterLayer,
        schemaRendererLayer,
        toolIdentifierLayer,
        pathLayer,
      ),
    ),
  );
  const layer = toolFindLayer.pipe(
    Layer.provide(
      Layer.mergeAll(discoveryLayer, metadataLayer, toolIdentifierLayer, toolSearchLayer),
    ),
  );
  return {
    find: (query: string, options?: ToolFindOptions) =>
      Effect.runPromise(
        ToolFindService.use((service) => service.find(query, options)).pipe(Effect.provide(layer)),
      ),
    render: (data: ToolFindData) =>
      Effect.runPromise(
        ToolFindService.use((service) => service.render(data)).pipe(Effect.provide(layer)),
      ),
  };
};

describe("ToolFind", () => {
  const homes = new ToolFindTestHome();

  afterEach(async () => {
    await homes.cleanup();
  });

  test("finds commands through descriptions, examples, fields, and typos", async () => {
    const homeDir = await homes.create();
    const service = findService(homeDir);
    const result = await service.find("grammer chek markdown");

    expect(result.results[0]).toMatchObject({
      rank: 1,
      id: "languagetool.check-file",
      tool: "languagetool",
      command: "check-file",
    });
    expect(result.results[0]?.runExample).toContain("notes.md");
    expect(result.results[0]?.matches.length).toBeGreaterThan(0);
    expect(await service.render(result)).toContain("1. languagetool.check-file");
  });

  test("supports tool filters, limits, input-field discovery, and no-result output", async () => {
    const homeDir = await homes.create();
    const service = findService(homeDir);
    const filtered = await service.find("width resize", { tool: "image", limit: "1" });

    expect(filtered).toMatchObject({ tool: "image", limit: 1 });
    expect(filtered.results).toMatchObject([{ id: "image.convert" }]);

    const empty = await service.find("quantum payroll");
    expect(await service.render(empty)).toBe('No Rig commands found for "quantum payroll".');
    const scopedEmpty = await service.find("quantum payroll", { tool: "image" });
    expect(await service.render(scopedEmpty)).toBe(
      'No Rig commands found for "quantum payroll" in tool image.',
    );
    expect(
      await service.render({
        ...filtered,
        results: filtered.results.map((result) => ({
          ...result,
          runExample: "rig run image.convert input=a\r\nb\rc\td",
        })),
      }),
    ).toContain("input=a\\nb\\rc\\td");
  });

  test("rejects invalid queries, limits, and tool filters", async () => {
    const homeDir = await homes.create();
    const service = findService(homeDir);
    await expect(service.find("   ")).rejects.toThrow("Find query cannot be empty");
    await expect(service.find("image", { limit: 0 })).rejects.toThrow("between 1 and 50");
    await expect(service.find("image", { limit: "1.5" })).rejects.toThrow("between 1 and 50");
    await expect(service.find("image", { tool: "missing" })).rejects.toThrow("Tool not found");
  });
});
