import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RigConfigStore, type ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { ToolLoader } from "./loader";

export class ToolCreator {
  private readonly configStore: RigConfigStore;
  private readonly loader: ToolLoader;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStore(options);
    this.loader = new ToolLoader(options);
  }

  async create(name: string) {
    this.loader.validateToolName(name);
    const config = await this.configStore.ensure();
    const baseRegistry = this.configStore.resolvedBaseRegistry(config);
    const toolDir = join(baseRegistry, name);
    const toolPath = join(toolDir, "tool.ts");

    if (existsSync(toolDir)) {
      throw new RigError("TOOL_INVALID", `Tool already exists: ${name}`, { path: toolDir });
    }

    await mkdir(toolDir, { recursive: true });
    await writeFile(toolPath, this.generatedToolSource(name), "utf8");

    return {
      name,
      command: "greet",
      id: `${name}.greet`,
      toolDir,
      toolPath,
      files: [toolPath],
    };
  }

  private generatedToolSource(name: string): string {
    return `import { RigTool, z } from "../../runtime/sdk";

export default RigTool.define({
  name: ${JSON.stringify(name)},
  description: "A starter tool that demonstrates Rig commands.",
  commands: {
    greet: {
      description: "Return a friendly greeting.",
      input: z.object({
        name: z.string().default("world"),
      }),
      output: z.object({
        message: z.string(),
      }),
      sideEffects: "read",
      examples: [
        {
          title: "Greet the world",
          text: "Use this to verify Rig can run a local command.",
          input: { name: "world" },
          output: { message: "Hello, world!" },
        },
        {
          title: "Greet a person",
          text: "Use this when the caller provides a name.",
          input: { name: "René-Pier" },
          output: { message: "Hello, René-Pier!" },
        },
      ],
      run: async ({ input }) => {
        return {
          message: \`Hello, \${input.name}!\`,
        };
      },
    },
  },
});
`;
  }
}
