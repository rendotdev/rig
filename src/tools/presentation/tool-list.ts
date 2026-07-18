import { readFile, stat } from "node:fs/promises";
import type { ConfigOptions } from "../../config/config";
import { AtomicFileWriterClass } from "../../config/file-lock";
import { RigPathsClass } from "../../config/paths";
import { ToolDiscoveryServiceClass, type DiscoveredTool } from "../../registry/discover";
import type { CollectionDefinition } from "../collection";
import { CurrentRigToolApiVersion } from "../domain/tool-api";
import { ToolLoaderClass, type LoadedToolDefinition } from "../loader";
import { schemaRenderer } from "../schema";
import { commandIds, type CommandDefinition, type ToolExample } from "../types";

export type ToolListOptions = {
  visibleFromPath?: string;
};

export type ListedCommand = {
  name: string;
  id: string;
  description: string;
  runExample: string;
  helpExample: string;
};

export type ListedCollection = {
  name: string;
  hasSchema: boolean;
};

export type ListedTool = {
  name: string;
  description: string;
  registryKind: string;
  registryPath: string;
  toolPath: string;
  commands: ListedCommand[];
  collections: ListedCollection[];
};

export type ToolListData = {
  tools: ListedTool[];
  visibleFromPath?: string;
};

export class CommandRunExampleRendererClass {
  render(toolName: string, commandName: string, command: CommandDefinition): string {
    const id = commandIds.from(toolName, commandName);
    const exampleInput = command.examples?.find((example) => example.input !== undefined)?.input;
    if (exampleInput !== undefined)
      return `rig run ${id} ${this.renderInputValue(exampleInput)}`.trimEnd();

    const args = this.renderRequiredInput(command.input);
    return `rig run ${id}${args ? ` ${args}` : ""}`;
  }

  private renderRequiredInput(schema: unknown): string {
    const jsonSchema = schemaRenderer.toJsonSchema(schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) return "";

    const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
    const fields = Object.entries(jsonSchema.properties)
      .filter(([name, property]) => required.includes(name) && !this.hasDefault(property))
      .map(([name, property]) => [name, this.placeholder(property)] as const);

    if (fields.length === 0) return "";
    if (fields.length <= 3) {
      return fields.map(([name, value]) => `${name}=${this.shellArg(value)}`).join(" ");
    }

    return `--input ${this.shellArg(
      JSON.stringify(Object.fromEntries(fields.map(([name, value]) => [name, value]))),
    )}`;
  }

  private renderInputValue(input: unknown): string {
    if (!this.isRecord(input)) return this.shellArg(String(input));
    return Object.entries(input)
      .map(([key, value]) => `${key}=${this.shellArg(this.inputScalar(value))}`)
      .join(" ");
  }

  private inputScalar(value: unknown): string {
    if (typeof value === "string") return value;
    /* v8 ignore next */
    return JSON.stringify(value) ?? String(value);
  }

  private placeholder(schema: unknown): string {
    /* v8 ignore next */
    if (!this.isRecord(schema)) return "VALUE";
    /* v8 ignore next */
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === "number" || type === "integer") return "0";
    if (type === "boolean") return "true";
    if (type === "array") return "[]";
    if (type === "object") return "{}";
    return "VALUE";
  }

  private hasDefault(schema: unknown): boolean {
    return this.isRecord(schema) && schema.default !== undefined;
  }

  private shellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

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

export class ToolMetadataCacheClass {
  private readonly paths: RigPathsClass;
  private readonly loader: ToolLoaderClass;
  private readonly writer = new AtomicFileWriterClass();
  private readonly exampleRenderer = new CommandRunExampleRendererClass();

  public constructor(options: ConfigOptions = {}) {
    this.paths = new RigPathsClass(options);
    this.loader = new ToolLoaderClass(options);
  }

  public async load(
    entries: DiscoveredTool[],
    options: { prune?: boolean } = {},
  ): Promise<ToolMetadata[]> {
    const current = await this.read();
    const nextEntries: Record<string, ToolMetadataCacheEntry> =
      options.prune === false ? { ...current.entries } : {};
    let changed = false;
    const metadata = await Promise.all(
      entries.map(async (entry) => {
        const status = await stat(entry.toolPath);
        const cached = current.entries[entry.toolPath];
        if (
          cached?.modifiedAtMs === status.mtimeMs &&
          cached.changedAtMs === status.ctimeMs &&
          cached.size === status.size &&
          this.isMetadata(cached.metadata)
        ) {
          nextEntries[entry.toolPath] = cached;
          return cached.metadata;
        }

        changed = true;
        const loaded = await this.loader.loadDefinitionDiscovered(entry);
        const value = this.metadata(loaded);
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
      Object.keys(current.entries).some((path) => nextEntries[path] === undefined)
    ) {
      changed = true;
    }
    if (changed)
      await this.write({
        version: 1,
        toolApiVersion: CurrentRigToolApiVersion,
        entries: nextEntries,
      });
    return metadata;
  }

  private metadata(loaded: LoadedToolDefinition): ToolMetadata {
    return {
      name: loaded.definition.name,
      description: loaded.definition.description,
      commands: Object.entries(loaded.definition.commands).map(([name, command]) => ({
        name,
        description: command.description,
        inputSchema: schemaRenderer.toJsonSchema(command.input),
        outputSchema: schemaRenderer.toJsonSchema(command.output),
        examples: command.examples ?? [],
        runExample: this.exampleRenderer.render(loaded.definition.name, name, command),
      })),
      collections: this.collections(loaded.definition),
    };
  }

  private collections(
    definition: Record<string, unknown> & {
      collections?: Record<string, CollectionDefinition | undefined>;
    },
  ): ListedCollection[] {
    const collections = definition.collections;
    if (!collections) return [];
    return Object.entries(collections).map(([name, value]) => ({
      name,
      hasSchema: Boolean(value?.schema),
    }));
  }

  private async read(): Promise<ToolMetadataCache> {
    try {
      /* v8 ignore next 3 */
      const value =
        typeof Bun !== "undefined"
          ? await Bun.file(this.paths.toolMetadataCachePath).json()
          : JSON.parse(await readFile(this.paths.toolMetadataCachePath, "utf8"));
      if (!this.isRecord(value) || value.version !== 1) return this.empty();
      if (value.toolApiVersion !== CurrentRigToolApiVersion || !this.isRecord(value.entries)) {
        return this.empty();
      }
      return value as ToolMetadataCache;
    } catch {
      return this.empty();
    }
  }

  private async write(cache: ToolMetadataCache): Promise<void> {
    try {
      await this.writer.write(
        this.paths.toolMetadataCachePath,
        `${JSON.stringify(cache, null, 2)}\n`,
      );
    } catch {
      // Metadata caching should never block discovery commands.
    }
  }

  private empty(): ToolMetadataCache {
    return { version: 1, toolApiVersion: CurrentRigToolApiVersion, entries: {} };
  }

  private isMetadata(value: unknown): value is ToolMetadata {
    return (
      this.isRecord(value) &&
      typeof value.name === "string" &&
      typeof value.description === "string" &&
      Array.isArray(value.commands) &&
      Array.isArray(value.collections)
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class ToolListPlainTextFormatterClass {
  description(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  example(value: string): string {
    return value
      .replace(/\r\n/g, "\\n")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .trim();
  }
}

class ToolListPlainRendererClass {
  private readonly formatter = new ToolListPlainTextFormatterClass();

  render(data: ToolListData): string {
    if (data.tools.length === 0) return "No Rig tools found.";

    return data.tools
      .map((tool) =>
        [
          this.renderToolHeader(tool),
          ...tool.commands.map((command) => this.renderCommand(command)),
        ].join("\n"),
      )
      .join("\n\n");
  }

  /* v8 ignore start */
  private renderToolHeader(tool: ListedTool): string {
    const collections =
      tool.collections.length > 0
        ? ` [collections: ${tool.collections.map((c) => c.name).join(", ")}]`
        : "";
    return `${tool.name} # ${this.formatter.description(tool.description)}${collections}`;
  }
  /* v8 ignore stop */

  private renderCommand(command: ListedCommand): string {
    const runExample = this.formatter.example(command.runExample);
    const description = this.formatter.description(command.description);
    return `  ${runExample} # ${description}`;
  }
}

export class ToolListServiceClass {
  private readonly discovery: ToolDiscoveryServiceClass;
  private readonly metadataCache: ToolMetadataCacheClass;
  private readonly plainRenderer = new ToolListPlainRendererClass();

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryServiceClass(options);
    this.metadataCache = new ToolMetadataCacheClass(options);
  }

  async list(options: ToolListOptions = {}): Promise<ToolListData> {
    const discovered = await this.discovery.discover({ visibleFromPath: options.visibleFromPath });
    const metadata = await this.metadataCache.load(discovered);
    const tools = discovered.map((entry, index) => {
      const tool = metadata[index]!;
      return {
        name: tool.name,
        description: tool.description,
        registryKind: entry.registryKind,
        registryPath: entry.registryPath,
        toolPath: entry.toolPath,
        commands: tool.commands.map((command) => ({
          name: command.name,
          id: commandIds.from(tool.name, command.name),
          description: command.description,
          runExample: command.runExample,
          helpExample: `rig help ${commandIds.from(tool.name, command.name)}`,
        })),
        collections: tool.collections,
      };
    });

    return { tools, visibleFromPath: options.visibleFromPath };
  }

  renderPlain(data: ToolListData): string {
    return this.plainRenderer.render(data);
  }
}
