import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { toolIdentifierLayer } from "../service/tool-identifier";
import { schemaRendererLayer } from "../service/schema-renderer";
import { toolDefinitionLayer } from "../service/tool-definition";
import { toolEnvironmentLayer } from "./tool-environment";
import { toolLoaderLayer } from "./tool-loader";
import { ToolEnvService, toolEnvLayer } from "./tool-env";
import { createRigToolKit, RigToolKitService } from "./tool-sdk";

class EnvWorkspaceStore {
  private readonly homes: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-env-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

class EnvToolWriter {
  constructor(private readonly home: string) {}

  async write(name: string, body: string, envFile?: string): Promise<string> {
    const toolDir = join(this.home, "rig", "tools", name);
    await mkdir(toolDir, { recursive: true });
    const toolPath = join(toolDir, "index.rig.ts");
    await writeFile(toolPath, body, "utf8");
    if (envFile !== undefined) await writeFile(join(toolDir, ".env"), envFile, "utf8");
    return toolDir;
  }
}

const needsTokenToolSource = `export default (rig) => rig.defineTool({
  name: "needs-token",
  description: "Env validation test tool.",
  env: rig.z.object({ TOKEN: rig.z.string() }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;

const badEnvFileToolSource = `export default (rig) => rig.defineTool({
  name: "bad-env-file",
  description: "Bad env file test tool.",
  env: rig.z.object({ TOKEN: rig.z.string() }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;

const noEnvSchemaToolSource = `export default (rig) => rig.defineTool({
  name: "no-env-schema",
  description: "No env schema test tool.",
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;

const scalarEnvToolSource = `export default (rig) => rig.defineTool({
  name: "scalar-env",
  description: "Scalar env schema test tool.",
  env: rig.z.string(),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;

const workspaces = new EnvWorkspaceStore();

const envService = (home: string) => {
  const discoveryLayer = Layer.succeed(ToolDiscoveryService, {
    discover: () => Effect.succeed([]),
    discoverRegistry: () => Effect.succeed([]),
    find: (name: string) =>
      Effect.succeed({
        name,
        registryKind: "base",
        registryPath: join(home, "rig", "tools"),
        toolDir: join(home, "rig", "tools", name),
        toolPath: join(home, "rig", "tools", name, "index.rig.ts"),
      } satisfies DiscoveredTool),
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
  const layer = toolEnvLayer.pipe(Layer.provide(Layer.merge(loaderLayer, schemaRendererLayer)));
  return {
    configure: (target: string, assignments?: string[]) =>
      Effect.runPromise(
        ToolEnvService.use((service) => service.configure(target, assignments)).pipe(
          Effect.provide(layer),
        ),
      ),
  };
};

const writeValidationToolFixtures = async (writer: EnvToolWriter) => {
  await writer.write("needs-token", needsTokenToolSource);
  await writer.write("bad-env-file", badEnvFileToolSource, "EMPTY=\nTOKEN=abc\nnot an env line\n");
  await writer.write("no-env-schema", noEnvSchemaToolSource);
  await writer.write("scalar-env", scalarEnvToolSource);
};

const expectEnvValidationFailures = async (service: ReturnType<typeof envService>) => {
  await expect(service.configure("needs-token.read.extra")).rejects.toThrow(
    "Env target must use <tool>",
  );
  await expect(service.configure("needs-token.missing")).rejects.toThrow(
    "Env target must use <tool>",
  );
  await expect(service.configure("no-env-schema")).rejects.toThrow(
    "Tool no-env-schema does not define an env schema.",
  );
  await expect(service.configure("needs-token", ["bad"])).rejects.toThrow(
    "Env assignment must use KEY=VALUE: bad",
  );
  await expect(service.configure("needs-token", ["BAD-KEY=value"])).rejects.toThrow(
    "Env assignment must use KEY=VALUE: BAD-KEY=value",
  );
  await expect(service.configure("needs-token", ["OTHER=value"])).rejects.toThrow(
    "Tool needs-token env would be invalid.",
  );
  await expect(service.configure("needs-token", ["remove"])).rejects.toThrow(
    "Env remove expects at least one KEY.",
  );
  await expect(service.configure("needs-token", ["remove", "BAD-KEY"])).rejects.toThrow(
    "Env key must be a valid shell variable name: BAD-KEY",
  );
  await expect(service.configure("needs-token", ["remove", "TOKEN"])).rejects.toThrow(
    "Tool needs-token env would be invalid.",
  );
  await expect(service.configure("bad-env-file")).rejects.toThrow("Invalid .env line.");
  await expect(service.configure("scalar-env")).resolves.toMatchObject({ entries: [] });
};

afterEach(async () => {
  await workspaces.cleanup();
});

describe("tool env service", () => {
  test("lists and writes tool env files without exposing values", async () => {
    const home = await workspaces.create();
    const toolDir = await new EnvToolWriter(home).write(
      "needs-env",
      `export default (rig) => rig.defineTool({
  name: "needs-env",
  description: "Env test tool.",
  env: rig.z.object({
    MODE: rig.z.string().default("dev"),
    OPTIONAL: rig.z.string().optional(),
    TOKEN: rig.z.string(),
  }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ token: rig.z.string() }),
      run: async (context) => ({ token: context.env.TOKEN }),
    }),
  },
});
`,
      `# existing settings
export TOKEN="old secret"
MODE='dev'
`,
    );

    const service = envService(home);
    const listed = await service.configure("needs-env");
    const updated = await service.configure("needs-env", [
      "TOKEN=new secret",
      "MODE=prod",
      "OPTIONAL=temporary",
    ]);
    const removed = await service.configure("needs-env", ["remove", "OPTIONAL"]);
    const removedAgain = await service.configure("needs-env", ["remove", "OPTIONAL"]);

    expect(listed).toMatchObject({
      tool: "needs-env",
      envPath: join(toolDir, ".env"),
      updated: false,
      updatedKeys: [],
      removedKeys: [],
      entries: [
        { key: "MODE", required: true, set: true },
        { key: "OPTIONAL", required: false, set: false },
        { key: "TOKEN", required: true, set: true },
      ],
    });
    expect(updated).toMatchObject({
      tool: "needs-env",
      updated: true,
      updatedKeys: ["MODE", "OPTIONAL", "TOKEN"],
      removedKeys: [],
      entries: [
        { key: "MODE", required: true, set: true },
        { key: "OPTIONAL", required: false, set: true },
        { key: "TOKEN", required: true, set: true },
      ],
    });
    expect(removed).toMatchObject({
      updated: true,
      updatedKeys: [],
      removedKeys: ["OPTIONAL"],
      entries: [
        { key: "MODE", required: true, set: true },
        { key: "OPTIONAL", required: false, set: false },
        { key: "TOKEN", required: true, set: true },
      ],
    });
    expect(removedAgain).toMatchObject({ updated: false, removedKeys: [] });
    expect(updated).not.toHaveProperty("values");
    expect(await readFile(join(toolDir, ".env"), "utf8")).toBe('MODE=prod\nTOKEN="new secret"\n');
  });

  test("reports env command validation errors", async () => {
    expect.assertions(11);
    const home = await workspaces.create();
    const writer = new EnvToolWriter(home);
    await writeValidationToolFixtures(writer);
    await expectEnvValidationFailures(envService(home));
  });
});
