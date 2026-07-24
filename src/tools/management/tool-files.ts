import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineService, defineSingleton } from "../../define";
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

function generatedToolSource(_params: {}): string {
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

export const ToolTemplateSingleton = defineSingleton({
  params: {},
  deps: {},
  render: generatedToolSource,
});

type ToolCreatorDeps = {
  ensureConfig: RigConfigStoreClass["ensure"];
  resolveBaseRegistry: RigConfigStoreClass["resolvedBaseRegistry"];
  validateToolName: ToolLoaderClass["validateToolName"];
  exists: typeof existsSync;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  join: typeof join;
  generatedToolSource: typeof generatedToolSource;
};

function createToolCreatorDeps(options: ConfigOptions): ToolCreatorDeps {
  const configStore = new RigConfigStoreClass(options);
  const loader = new ToolLoaderClass(options);
  return {
    ensureConfig: configStore.ensure.bind(configStore),
    resolveBaseRegistry: configStore.resolvedBaseRegistry.bind(configStore),
    validateToolName: loader.validateToolName.bind(loader),
    exists: existsSync,
    mkdir,
    writeFile,
    join,
    generatedToolSource,
  };
}

const ToolCreatorProductionDeps = createToolCreatorDeps({});

export class ToolCreatorService extends defineService({
  params: {},
  deps: ToolCreatorProductionDeps,
}) {
  public async create(params: { name: string }) {
    this.deps.validateToolName(params.name);
    const config = await this.deps.ensureConfig();
    const baseRegistry = this.deps.resolveBaseRegistry(config);
    const toolDir = this.deps.join(baseRegistry, params.name);
    const toolPath = this.deps.join(toolDir, RigToolEntryFiles[0]);

    if (this.deps.exists(toolDir)) {
      throw new RigErrorClass("TOOL_INVALID", `Tool already exists: ${params.name}`, {
        path: toolDir,
      });
    }

    await this.deps.mkdir(toolDir, { recursive: true });
    await this.deps.writeFile(toolPath, this.deps.generatedToolSource({}), "utf8");

    return {
      name: params.name,
      command: "example",
      id: `${params.name}.example`,
      toolDir,
      toolPath,
      files: [toolPath],
    };
  }
}

export const ToolCreator = new ToolCreatorService();

export type ToolCreatorClass = {
  create(name: string): ReturnType<ToolCreatorService["create"]>;
};

type ToolCreatorConstructor = {
  new (options?: ConfigOptions): ToolCreatorClass;
  readonly prototype: ToolCreatorClass;
};

type ToolCreatorAdapter = ToolCreatorClass & { readonly resource: ToolCreatorService };

const ToolCreatorClassAdapter = function constructToolCreator(
  this: ToolCreatorAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolCreatorService({ params: {}, deps: createToolCreatorDeps(options) }),
  });
};
Object.defineProperty(ToolCreatorClassAdapter, "name", { value: "ToolCreatorClass" });
Object.defineProperty(ToolCreatorClassAdapter.prototype, "create", {
  configurable: true,
  value: function create(this: ToolCreatorAdapter, name: string) {
    return this.resource.create({ name });
  },
  writable: true,
});

export const ToolCreatorClass = ToolCreatorClassAdapter as unknown as ToolCreatorConstructor;

type ToolFileServiceDeps = {
  validateToolName: ToolLoaderClass["validateToolName"];
  findTool: ToolDiscoveryServiceClass["find"];
};

function createToolFileServiceDeps(options: ConfigOptions): ToolFileServiceDeps {
  const discovery = new ToolDiscoveryServiceClass(options);
  const loader = new ToolLoaderClass(options);
  return {
    validateToolName: loader.validateToolName.bind(loader),
    findTool: discovery.find.bind(discovery),
  };
}

const ToolFileServiceProductionDeps = createToolFileServiceDeps({});

export class ToolFileService extends defineService({
  params: {},
  deps: ToolFileServiceProductionDeps,
}) {
  public async path(params: { name: string }): Promise<ToolFileResult> {
    this.deps.validateToolName(params.name);
    const tool = await this.deps.findTool(params.name);
    return { name: tool.name, toolDir: tool.toolDir, toolPath: tool.toolPath };
  }
}

export const ToolFile = new ToolFileService();

export type ToolFileServiceClass = {
  path(name: string): Promise<ToolFileResult>;
};

type ToolFileServiceConstructor = {
  new (options?: ConfigOptions): ToolFileServiceClass;
  readonly prototype: ToolFileServiceClass;
};

type ToolFileServiceAdapter = ToolFileServiceClass & {
  readonly resource: ToolFileService;
};

const ToolFileServiceClassAdapter = function constructToolFileService(
  this: ToolFileServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolFileService({ params: {}, deps: createToolFileServiceDeps(options) }),
  });
};
Object.defineProperty(ToolFileServiceClassAdapter, "name", { value: "ToolFileServiceClass" });
Object.defineProperty(ToolFileServiceClassAdapter.prototype, "path", {
  configurable: true,
  value: function path(this: ToolFileServiceAdapter, name: string) {
    return this.resource.path({ name });
  },
  writable: true,
});

export const ToolFileServiceClass =
  ToolFileServiceClassAdapter as unknown as ToolFileServiceConstructor;

type ToolRemoverDeps = {
  findPath: ToolFileServiceClass["path"];
  rm: typeof rm;
};

function createToolRemoverDeps(options: ConfigOptions): ToolRemoverDeps {
  const files = new ToolFileServiceClass(options);
  return { findPath: files.path.bind(files), rm };
}

const ToolRemoverProductionDeps = createToolRemoverDeps({});

export class ToolRemoverService extends defineService({
  params: {},
  deps: ToolRemoverProductionDeps,
}) {
  public async remove(params: { name: string }): Promise<ToolFileResult> {
    const tool = await this.deps.findPath(params.name);
    await this.deps.rm(tool.toolDir, { recursive: true, force: false });
    return tool;
  }
}

export const ToolRemover = new ToolRemoverService();

export type ToolRemoverClass = {
  remove(name: string): Promise<ToolFileResult>;
};

type ToolRemoverConstructor = {
  new (options?: ConfigOptions): ToolRemoverClass;
  readonly prototype: ToolRemoverClass;
};

type ToolRemoverAdapter = ToolRemoverClass & { readonly resource: ToolRemoverService };

const ToolRemoverClassAdapter = function constructToolRemover(
  this: ToolRemoverAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolRemoverService({ params: {}, deps: createToolRemoverDeps(options) }),
  });
};
Object.defineProperty(ToolRemoverClassAdapter, "name", { value: "ToolRemoverClass" });
Object.defineProperty(ToolRemoverClassAdapter.prototype, "remove", {
  configurable: true,
  value: function remove(this: ToolRemoverAdapter, name: string) {
    return this.resource.remove({ name });
  },
  writable: true,
});

export const ToolRemoverClass = ToolRemoverClassAdapter as unknown as ToolRemoverConstructor;
