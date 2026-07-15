import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RigConfigStoreClass, type ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { RigToolEntryFiles, ToolDiscoveryServiceClass } from "../../registry/discover";
import { CurrentRigToolApiVersion } from "../domain/tool-api";
import { ToolLoaderClass } from "../loader";

export type ToolFileResult = {
  name: string;
  toolDir: string;
  toolPath: string;
};

export class ToolCreatorClass {
  private readonly configStore: RigConfigStoreClass;
  private readonly loader: ToolLoaderClass;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStoreClass(options);
    this.loader = new ToolLoaderClass(options);
  }

  async create(name: string) {
    this.loader.validateToolName(name);
    const config = await this.configStore.ensure();
    const baseRegistry = this.configStore.resolvedBaseRegistry(config);
    const toolDir = join(baseRegistry, name);
    const toolPath = join(toolDir, RigToolEntryFiles[0]);

    if (existsSync(toolDir)) {
      throw new RigErrorClass("TOOL_INVALID", `Tool already exists: ${name}`, { path: toolDir });
    }

    await mkdir(toolDir, { recursive: true });
    await writeFile(toolPath, this.generatedToolSource(), "utf8");

    return {
      name,
      command: "example",
      id: `${name}.example`,
      toolDir,
      toolPath,
      files: [toolPath],
    };
  }

  private generatedToolSource(): string {
    return `// rig:tool-api-version ${CurrentRigToolApiVersion}
export default (rig: RigToolKit) => rig.defineTool({
  description: "Describe what this tool does.",
  commands: (command) => ({
    example: command({
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
      ],
      run: async ({ input }) => {
        return {
          text: input.text,
        };
      },
    }),
  }),
});
`;
  }
}

export class ToolFileServiceClass {
  private readonly discovery: ToolDiscoveryServiceClass;
  private readonly loader: ToolLoaderClass;

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryServiceClass(options);
    this.loader = new ToolLoaderClass(options);
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

export class ToolRemoverClass {
  private readonly files: ToolFileServiceClass;

  constructor(options: ConfigOptions = {}) {
    this.files = new ToolFileServiceClass(options);
  }

  async remove(name: string): Promise<ToolFileResult> {
    const tool = await this.files.path(name);
    await rm(tool.toolDir, { recursive: true, force: false });
    return tool;
  }
}
