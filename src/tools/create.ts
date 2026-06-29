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
      command: "example",
      id: `${name}.example`,
      toolDir,
      toolPath,
      files: [toolPath],
    };
  }

  private generatedToolSource(name: string): string {
    return `import { RigTool, z } from "../../runtime/sdk";

export default RigTool.define({
  name: ${JSON.stringify(name)},
  description: "Describe what this tool does.",
  commands: {
    example: {
      description: "Example command. Replace this with a real command.",
      input: z.object({
        text: z.string().default("example"),
      }),
      output: z.object({
        text: z.string(),
      }),
      sideEffects: "read",
      examples: [
        {
          title: "Run the example command",
          text: "Use this to verify Rig can run a local command.",
          input: { text: "example" },
          output: { text: "example" },
        },
        {
          title: "Pass custom text",
          text: "Use this to see how arguments map into command input.",
          input: { text: "custom" },
          output: { text: "custom" },
        },
      ],
      run: async ({ input }) => {
        return {
          text: input.text,
        };
      },
    },
  },
});
`;
  }
}
