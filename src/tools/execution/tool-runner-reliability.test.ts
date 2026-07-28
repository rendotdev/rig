import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRunnerClass } from "./tool-runner";

class ReliabilityTestHomeClass {
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

const homes = new ReliabilityTestHomeClass();

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

  const result = await new ToolRunnerClass({ homeDir: home }).run("circular-output", "read", {
    homeDir: home,
  });

  expect(result).toMatchObject({
    exitCode: 1,
    envelope: { errors: [{ code: "INTERNAL_ERROR" }] },
  });
});
