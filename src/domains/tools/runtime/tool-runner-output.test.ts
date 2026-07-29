import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
} from "../../../providers/paths/rig-paths";
import { RunToolTestService, runTestHarnessLayer } from "./run-test-harness-service";

class RunOutputTestHome {
  private readonly paths: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-output-test-"));
    this.paths.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

const homes = new RunOutputTestHome();
const layerForHome = (homeDir: string) =>
  runTestHarnessLayer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(RigPathsOptionsConfigService, { homeDir }),
        RigPathsPlatformService.layer,
      ),
    ),
  );
const run = <A, E>(homeDir: string, effect: Effect.Effect<A, E, RunToolTestService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layerForHome(homeDir))));

afterEach(async () => homes.cleanup());

describe("tool command output", () => {
  test("renders a compact plain command list", async () => {
    const home = await homes.create();
    await run(
      home,
      RunToolTestService.use((service) => service.createTool("sample")),
    );
    const list = await run(
      home,
      RunToolTestService.use((service) => service.list),
    );
    const rendered = await run(
      home,
      RunToolTestService.use((service) => service.renderList(list)),
    );
    expect(rendered).toContain("rig run sample.example text=example #");
  });

  test("dry-runs a command without execution", async () => {
    const home = await homes.create();
    await run(
      home,
      RunToolTestService.use((service) => service.createTool("sample")),
    );
    const toolDir = join(home, "rig", "tools", "writer");
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

    const result = await run(
      home,
      RunToolTestService.use((service) =>
        service.run("writer", "save", { homeDir: home, args: ["text=Agent"], dryRun: true }),
      ),
    );
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
    const toolDir = join(home, "rig", "tools", "large");
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
    const result = await run(
      home,
      RunToolTestService.use((service) => service.run("large", "dump", { homeDir: home })),
    );
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
    const toolDir = join(home, "rig", "tools", "raw-schema");
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
    const result = await run(
      home,
      RunToolTestService.use((service) =>
        service.run("raw-schema", "echo", { homeDir: home, input: '{"text":"Agent"}' }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({ data: { text: "Agent" }, errors: [] });
  });

  test("returns an error envelope for invalid input", async () => {
    const home = await homes.create();
    await run(
      home,
      RunToolTestService.use((service) => service.createTool("sample")),
    );
    const result = await run(
      home,
      RunToolTestService.use((service) =>
        service.run("sample", "example", { homeDir: home, input: '{"text":123}' }),
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      data: null,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "Invalid input.",
          details: { issues: [{ path: "text", message: expect.any(String) }] },
        },
      ],
    });
  });
});
