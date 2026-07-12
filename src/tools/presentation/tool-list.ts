import type { ConfigOptions } from "../../config/config";
import type { CollectionDefinition } from "../collection";
import { ToolDiscoveryServiceClass } from "../../registry/discover";
import { schemaRenderer } from "../schema";
import { ToolLoaderClass } from "../loader";
import { commandIds, type CommandDefinition } from "../types";

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

class CommandRunExampleRendererClass {
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
  private readonly loader: ToolLoaderClass;
  private readonly exampleRenderer = new CommandRunExampleRendererClass();
  private readonly plainRenderer = new ToolListPlainRendererClass();

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryServiceClass(options);
    this.loader = new ToolLoaderClass(options);
  }

  async list(options: ToolListOptions = {}): Promise<ToolListData> {
    const discovered = await this.discovery.discover({ visibleFromPath: options.visibleFromPath });
    const tools = await Promise.all(
      discovered.map(async (entry) => {
        const loaded = await this.loader.loadDiscovered(entry);
        const commands = Object.entries(loaded.definition.commands).map(([name, command]) => ({
          name,
          id: commandIds.from(loaded.definition.name, name),
          description: command.description,
          runExample: this.exampleRenderer.render(loaded.definition.name, name, command),
          helpExample: `rig help ${commandIds.from(loaded.definition.name, name)}`,
        }));
        const collections = this.listCollections(loaded.definition);
        return {
          name: loaded.definition.name,
          description: loaded.definition.description,
          registryKind: entry.registryKind,
          registryPath: entry.registryPath,
          toolPath: entry.toolPath,
          commands,
          collections,
        };
      }),
    );

    return { tools, visibleFromPath: options.visibleFromPath };
  }

  renderPlain(data: ToolListData): string {
    return this.plainRenderer.render(data);
  }

  /* v8 ignore start */
  private listCollections(
    definition: Record<string, unknown> & {
      collections?: Record<string, CollectionDefinition | undefined>;
    },
  ): ListedCollection[] {
    const collections = definition.collections;
    if (!collections) return [];
    return Object.entries(collections).map(([name, def]) => ({
      name,
      hasSchema: Boolean(def?.schema),
    }));
  }
  /* v8 ignore stop */
}
