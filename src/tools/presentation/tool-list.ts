import { readFile, stat } from "node:fs/promises";
import { defineService, defineSingleton } from "../../define";
import { AtomicFileWriterClass } from "../../config/file-lock";
import type { ConfigOptions } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { ToolDiscoveryServiceClass, type DiscoveredTool } from "../../registry/discover";
import type { CollectionDefinition } from "../collection";
import { CurrentRigToolApiVersion } from "../domain/tool-api";
import { ToolLoaderClass, type LoadedToolDefinition } from "../loader";
import { schemaRenderer } from "../schema";
import { commandIds, type CommandDefinition, type ToolExample } from "../types";

export type ToolListOptions = { visibleFromPath?: string };

export type ListedCommand = {
  name: string;
  id: string;
  description: string;
  runExample: string;
  helpExample: string;
};

export type ListedCollection = { name: string; hasSchema: boolean };

export type ListedTool = {
  name: string;
  description: string;
  registryKind: string;
  registryPath: string;
  toolPath: string;
  commands: ListedCommand[];
  collections: ListedCollection[];
};

export type ToolListData = { tools: ListedTool[]; visibleFromPath?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellArg(params: { value: string }): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(params.value)) return params.value;
  return `'${params.value.replaceAll("'", "'\\''")}'`;
}

function placeholder(params: { schema: unknown }): string {
  /* v8 ignore next */
  if (!isRecord(params.schema)) return "VALUE";
  /* v8 ignore next */
  const type = Array.isArray(params.schema.type) ? params.schema.type[0] : params.schema.type;
  if (type === "number" || type === "integer") return "0";
  if (type === "boolean") return "true";
  if (type === "array") return "[]";
  if (type === "object") return "{}";
  return "VALUE";
}

function renderRequiredInput(params: { schema: unknown }): string {
  const jsonSchema = schemaRenderer.toJsonSchema(params.schema);
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema.properties)) return "";

  const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  const fields = Object.entries(jsonSchema.properties)
    .filter(function requiredWithoutDefault([name, property]) {
      return required.includes(name) && !(isRecord(property) && property.default !== undefined);
    })
    .map(function inputField([name, property]) {
      return [name, placeholder({ schema: property })] as const;
    });

  if (fields.length === 0) return "";
  if (fields.length <= 3) {
    return fields
      .map(function renderField([name, value]) {
        return `${name}=${shellArg({ value })}`;
      })
      .join(" ");
  }

  return `--input ${shellArg({ value: JSON.stringify(Object.fromEntries(fields)) })}`;
}

function inputScalar(params: { value: unknown }): string {
  if (typeof params.value === "string") return params.value;
  /* v8 ignore next */
  return JSON.stringify(params.value) ?? String(params.value);
}

function renderInputValue(params: { input: unknown }): string {
  if (!isRecord(params.input)) return shellArg({ value: String(params.input) });
  return Object.entries(params.input)
    .map(function renderEntry([key, value]) {
      return `${key}=${shellArg({ value: inputScalar({ value }) })}`;
    })
    .join(" ");
}

function renderCommandRunExample(params: {
  toolName: string;
  commandName: string;
  command: CommandDefinition;
}): string {
  const id = commandIds.from(params.toolName, params.commandName);
  const exampleInput = params.command.examples?.find(function withInput(example) {
    return example.input !== undefined;
  })?.input;
  if (exampleInput !== undefined) {
    return `rig run ${id} ${renderInputValue({ input: exampleInput })}`.trimEnd();
  }
  const args = renderRequiredInput({ schema: params.command.input });
  return `rig run ${id}${args ? ` ${args}` : ""}`;
}

export const CommandRunExampleRendererSingleton = defineSingleton({
  params: {},
  deps: {},
  render: renderCommandRunExample,
});

export type CommandRunExampleRendererClass = {
  render(toolName: string, commandName: string, command: CommandDefinition): string;
};

type CommandRunExampleRendererConstructor = {
  new (): CommandRunExampleRendererClass;
  readonly prototype: CommandRunExampleRendererClass;
};

const CommandRunExampleRendererClassAdapter =
  function constructCommandRunExampleRenderer(): void {};
Object.defineProperty(CommandRunExampleRendererClassAdapter, "name", {
  value: "CommandRunExampleRendererClass",
});
Object.defineProperty(CommandRunExampleRendererClassAdapter.prototype, "render", {
  configurable: true,
  value: function renderLegacyExample(
    toolName: string,
    commandName: string,
    command: CommandDefinition,
  ) {
    return CommandRunExampleRendererSingleton.render({ toolName, commandName, command });
  },
  writable: true,
});

export const CommandRunExampleRendererClass =
  CommandRunExampleRendererClassAdapter as unknown as CommandRunExampleRendererConstructor;

export type ToolCommandMetadata = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  examples: ToolExample[];
  runExample: string;
};

export type ToolMetadata = {
  name: string;
  description: string;
  commands: ToolCommandMetadata[];
  collections: ListedCollection[];
};

type ToolMetadataCacheEntry = {
  modifiedAtMs: number;
  changedAtMs: number;
  size: number;
  metadata: ToolMetadata;
};

type ToolMetadataCache = {
  version: 1;
  toolApiVersion: number;
  entries: Record<string, ToolMetadataCacheEntry>;
};

function emptyMetadataCache(_params: {}): ToolMetadataCache {
  return { version: 1, toolApiVersion: CurrentRigToolApiVersion, entries: {} };
}

function isMetadata(params: { value: unknown }): params is { value: ToolMetadata } {
  return (
    isRecord(params.value) &&
    typeof params.value.name === "string" &&
    typeof params.value.description === "string" &&
    Array.isArray(params.value.commands) &&
    Array.isArray(params.value.collections)
  );
}

function listedCollections(params: {
  definition: Record<string, unknown> & {
    collections?: Record<string, CollectionDefinition | undefined>;
  };
}): ListedCollection[] {
  const collections = params.definition.collections;
  if (!collections) return [];
  return Object.entries(collections).map(function listedCollection([name, value]) {
    return { name, hasSchema: Boolean(value?.schema) };
  });
}

function toolMetadata(params: { loaded: LoadedToolDefinition }): ToolMetadata {
  return {
    name: params.loaded.definition.name,
    description: params.loaded.definition.description,
    commands: Object.entries(params.loaded.definition.commands).map(function metadataCommand([
      name,
      command,
    ]) {
      return {
        name,
        description: command.description,
        inputSchema: schemaRenderer.toJsonSchema(command.input),
        outputSchema: schemaRenderer.toJsonSchema(command.output),
        examples: command.examples ?? [],
        runExample: CommandRunExampleRendererSingleton.render({
          toolName: params.loaded.definition.name,
          commandName: name,
          command,
        }),
      };
    }),
    collections: listedCollections({ definition: params.loaded.definition }),
  };
}

type ToolMetadataCacheDeps = {
  cachePath: string;
  loadDefinition: ToolLoaderClass["loadDefinitionDiscovered"];
  readJson: (path: string) => Promise<unknown>;
  write: AtomicFileWriterClass["write"];
  stat: typeof stat;
};

function createToolMetadataCacheDeps(options: ConfigOptions): ToolMetadataCacheDeps {
  const paths = new RigPathsClass(options);
  const loader = new ToolLoaderClass(options);
  const writer = new AtomicFileWriterClass();
  return {
    cachePath: paths.toolMetadataCachePath,
    loadDefinition: loader.loadDefinitionDiscovered.bind(loader),
    async readJson(path) {
      /* v8 ignore next 3 */
      return typeof Bun !== "undefined"
        ? await Bun.file(path).json()
        : JSON.parse(await readFile(path, "utf8"));
    },
    write: writer.write.bind(writer),
    stat,
  };
}

const ToolMetadataCacheProductionDeps = createToolMetadataCacheDeps({});

export class ToolMetadataCacheService extends defineService({
  params: {},
  deps: ToolMetadataCacheProductionDeps,
}) {
  private async read(_params: {}): Promise<ToolMetadataCache> {
    try {
      const value = await this.deps.readJson(this.deps.cachePath);
      if (!isRecord(value) || value.version !== 1) return emptyMetadataCache({});
      if (value.toolApiVersion !== CurrentRigToolApiVersion || !isRecord(value.entries)) {
        return emptyMetadataCache({});
      }
      return value as ToolMetadataCache;
    } catch {
      return emptyMetadataCache({});
    }
  }

  private async write(params: { cache: ToolMetadataCache }): Promise<void> {
    try {
      await this.deps.write(this.deps.cachePath, `${JSON.stringify(params.cache, null, 2)}\n`);
    } catch {
      // Metadata caching should never block discovery commands.
    }
  }

  public async load(params: {
    entries: DiscoveredTool[];
    options: { prune?: boolean };
  }): Promise<ToolMetadata[]> {
    const options = params.options;
    const current = await this.read({});
    const nextEntries: Record<string, ToolMetadataCacheEntry> =
      options.prune === false ? { ...current.entries } : {};
    let changed = false;
    const metadata = await Promise.all(
      params.entries.map(async (entry) => {
        const status = await this.deps.stat(entry.toolPath);
        const cached = current.entries[entry.toolPath];
        const candidate = { value: cached?.metadata };
        if (
          cached?.modifiedAtMs === status.mtimeMs &&
          cached.changedAtMs === status.ctimeMs &&
          cached.size === status.size &&
          isMetadata(candidate)
        ) {
          nextEntries[entry.toolPath] = cached;
          return candidate.value;
        }

        changed = true;
        const loaded = await this.deps.loadDefinition(entry);
        const value = toolMetadata({ loaded });
        nextEntries[entry.toolPath] = {
          modifiedAtMs: status.mtimeMs,
          changedAtMs: status.ctimeMs,
          size: status.size,
          metadata: value,
        };
        return value;
      }),
    );
    if (
      options.prune !== false &&
      Object.keys(current.entries).some(function missingEntry(path) {
        return nextEntries[path] === undefined;
      })
    ) {
      changed = true;
    }
    if (changed) {
      await this.write({
        cache: {
          version: 1,
          toolApiVersion: CurrentRigToolApiVersion,
          entries: nextEntries,
        },
      });
    }
    return metadata;
  }
}

export const ToolMetadataCache = new ToolMetadataCacheService();

export type ToolMetadataCacheClass = {
  load(entries: DiscoveredTool[], options?: { prune?: boolean }): Promise<ToolMetadata[]>;
};

type ToolMetadataCacheConstructor = {
  new (options?: ConfigOptions): ToolMetadataCacheClass;
  readonly prototype: ToolMetadataCacheClass;
};

type ToolMetadataCacheAdapter = ToolMetadataCacheClass & {
  readonly resource: ToolMetadataCacheService;
};

const ToolMetadataCacheClassAdapter = function constructToolMetadataCache(
  this: ToolMetadataCacheAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolMetadataCacheService({
      params: {},
      deps: createToolMetadataCacheDeps(options),
    }),
  });
};
Object.defineProperty(ToolMetadataCacheClassAdapter, "name", { value: "ToolMetadataCacheClass" });
Object.defineProperty(ToolMetadataCacheClassAdapter.prototype, "load", {
  configurable: true,
  value: function load(
    this: ToolMetadataCacheAdapter,
    entries: DiscoveredTool[],
    options: { prune?: boolean } = {},
  ) {
    return this.resource.load({ entries, options });
  },
  writable: true,
});

export const ToolMetadataCacheClass =
  ToolMetadataCacheClassAdapter as unknown as ToolMetadataCacheConstructor;

function plainDescription(params: { value: string }): string {
  return params.value.replace(/\s+/g, " ").trim();
}

function plainExample(params: { value: string }): string {
  return params.value
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .trim();
}

/* v8 ignore start */
function renderToolHeader(params: { tool: ListedTool }): string {
  const collections =
    params.tool.collections.length > 0
      ? ` [collections: ${params.tool.collections.map((collection) => collection.name).join(", ")}]`
      : "";
  return `${params.tool.name} # ${plainDescription({ value: params.tool.description })}${collections}`;
}
/* v8 ignore stop */

function renderPlainList(params: { data: ToolListData }): string {
  if (params.data.tools.length === 0) return "No Rig tools found.";
  return params.data.tools
    .map(function renderTool(tool) {
      return [
        renderToolHeader({ tool }),
        ...tool.commands.map(function renderCommand(command) {
          return `  ${plainExample({ value: command.runExample })} # ${plainDescription({ value: command.description })}`;
        }),
      ].join("\n");
    })
    .join("\n\n");
}

export const ToolListPlainRendererSingleton = defineSingleton({
  params: {},
  deps: {},
  render: renderPlainList,
});

type ToolListServiceDeps = {
  discover: ToolDiscoveryServiceClass["discover"];
  loadMetadata: ToolMetadataCacheClass["load"];
};

function createToolListServiceDeps(options: ConfigOptions): ToolListServiceDeps {
  const discovery = new ToolDiscoveryServiceClass(options);
  const metadataCache = new ToolMetadataCacheClass(options);
  return {
    discover: discovery.discover.bind(discovery),
    loadMetadata: metadataCache.load.bind(metadataCache),
  };
}

const ToolListServiceProductionDeps = createToolListServiceDeps({});

export class ToolListService extends defineService({
  params: {},
  deps: ToolListServiceProductionDeps,
}) {
  public async list(options: ToolListOptions = {}): Promise<ToolListData> {
    const discovered = await this.deps.discover({ visibleFromPath: options.visibleFromPath });
    const metadata = await this.deps.loadMetadata(discovered);
    const tools = discovered.map(function listedTool(entry, index) {
      const tool = metadata[index]!;
      return {
        name: tool.name,
        description: tool.description,
        registryKind: entry.registryKind,
        registryPath: entry.registryPath,
        toolPath: entry.toolPath,
        commands: tool.commands.map(function listedCommand(command) {
          return {
            name: command.name,
            id: commandIds.from(tool.name, command.name),
            description: command.description,
            runExample: command.runExample,
            helpExample: `rig help ${commandIds.from(tool.name, command.name)}`,
          };
        }),
        collections: tool.collections,
      };
    });
    return { tools, visibleFromPath: options.visibleFromPath };
  }

  public renderPlain(params: { data: ToolListData }): string {
    return ToolListPlainRendererSingleton.render(params);
  }
}

export const ToolList = new ToolListService();

export type ToolListServiceClass = {
  list(options?: ToolListOptions): Promise<ToolListData>;
  renderPlain(data: ToolListData): string;
};

type ToolListServiceConstructor = {
  new (options?: ConfigOptions): ToolListServiceClass;
  readonly prototype: ToolListServiceClass;
};

type ToolListServiceAdapter = ToolListServiceClass & { readonly resource: ToolListService };

const ToolListServiceClassAdapter = function constructToolListService(
  this: ToolListServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolListService({ params: {}, deps: createToolListServiceDeps(options) }),
  });
};
Object.defineProperty(ToolListServiceClassAdapter, "name", { value: "ToolListServiceClass" });
Object.defineProperties(ToolListServiceClassAdapter.prototype, {
  list: {
    configurable: true,
    value: function list(this: ToolListServiceAdapter, options: ToolListOptions = {}) {
      return this.resource.list(options);
    },
    writable: true,
  },
  renderPlain: {
    configurable: true,
    value: function renderPlain(this: ToolListServiceAdapter, data: ToolListData) {
      return this.resource.renderPlain({ data });
    },
    writable: true,
  },
});

export const ToolListServiceClass =
  ToolListServiceClassAdapter as unknown as ToolListServiceConstructor;
