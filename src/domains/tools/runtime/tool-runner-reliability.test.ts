/** @effect-diagnostics strictEffectProvide:skip-file */
import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
} from "../../../providers/paths/rig-paths";
import { toolServicesLayer } from "./tool-services-layer";
import { ToolRunnerService } from "./tool-runner";

class ReliabilityTestHome {
  private readonly paths: string[] = [];

  async create(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-effect-reliability-"));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

const homes = new ReliabilityTestHome();

afterEach(async () => homes.cleanup());

test("returns an error envelope when output serialization fails", async () => {
  const home = await homes.create();
  const toolDirectory = join(home, "rig", "tools", "circular-output");
  await mkdir(toolDirectory, { recursive: true });
  await writeFile(
    join(toolDirectory, "index.rig.ts"),
    `export default (rig) => rig.defineTool({
  name: "circular-output",
  description: "Reliability test tool.",
  commands: {
    read: rig.defineCommand({
      description: "Return a circular result.",
      input: rig.z.object({}),
      output: rig.z.any(),
      run: () => {
        const result = {};
        result.self = result;
        return result;
      },
    }),
  },
});
`,
    "utf8",
  );

  const layer = toolServicesLayer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(RigPathsOptionsConfigService, { homeDir: home }),
        RigPathsPlatformService.layer,
      ),
    ),
  );
  const result = await Effect.runPromise(
    ToolRunnerService.use((service) =>
      service.run("circular-output", "read", { homeDir: home }),
    ).pipe(Effect.provide(layer)),
  );

  expect(result).toMatchObject({
    exitCode: 1,
    envelope: { errors: [{ code: "INTERNAL_ERROR" }] },
  });
});
