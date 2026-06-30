import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RigConfigStore, type ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { RigToolEntryFiles, ToolDiscoveryService } from "../registry/discover";
import { ToolLoader } from "./loader";

export type ToolFileResult = {
  name: string;
  toolDir: string;
  toolPath: string;
};

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
    const toolPath = join(toolDir, RigToolEntryFiles[0]);

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
    return `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: ${JSON.stringify(name)},
  description: "Describe what this tool does.",
  commands: {
    example: rig.defineCommand({
      description: "Example command. Replace this with a real command.",
      input: rig.z.object({
        text: rig.z.string().default("example"),
      }),
      output: rig.z.object({
        text: rig.z.string(),
      }),
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
      run: async (context) => {
        return {
          text: context.input.text,
        };
      },
    }),
  },
});

export default tool;
`;
  }
}

export class ToolFileService {
  private readonly discovery: ToolDiscoveryService;
  private readonly loader: ToolLoader;

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryService(options);
    this.loader = new ToolLoader(options);
  }

  async path(name: string): Promise<ToolFileResult> {
    this.loader.validateToolName(name);
    const tool = await this.discovery.find(name);
    return {
      name: tool.name,
      toolDir: tool.toolDir,
      toolPath: tool.toolPath,
    };
  }
}

export class ToolRemover {
  private readonly files: ToolFileService;

  constructor(options: ConfigOptions = {}) {
    this.files = new ToolFileService(options);
  }

  async remove(name: string): Promise<ToolFileResult> {
    const tool = await this.files.path(name);
    await rm(tool.toolDir, { recursive: true, force: false });
    return tool;
  }
}
