import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolDiscoveryServiceClass } from "../../registry/discover";
import { toolSearchEngine, type ToolSearchDocument } from "../domain/tool-search";
import { ToolNameClass } from "../identifiers";
import { ToolLoaderClass } from "../loader";
import { schemaRenderer } from "../schema";
import { commandIds, type CommandDefinition, type ToolExample } from "../types";
import { CommandRunExampleRendererClass } from "./tool-list";

export type ToolFindOptions = {
  limit?: number | string;
  tool?: string;
};

export type ToolFindMatch = {
  field: string;
  value: string;
  score: number;
};

export type ToolFindResult = {
  rank: number;
  score: number;
  id: string;
  tool: string;
  command: string;
  description: string;
  runExample: string;
  matches: ToolFindMatch[];
};

export type ToolFindData = {
  query: string;
  tool?: string;
  limit: number;
  results: ToolFindResult[];
};

type SearchableCommand = {
  id: string;
  tool: string;
  command: string;
  description: string;
  runExample: string;
  document: ToolSearchDocument;
};

class ToolFindMetadataClass {
  private readonly exampleRenderer = new CommandRunExampleRendererClass();

  public command(params: {
    toolName: string;
    toolDescription: string;
    commandName: string;
    command: CommandDefinition;
  }): SearchableCommand {
    const id = commandIds.from(params.toolName, params.commandName);
    return {
      id,
      tool: params.toolName,
      command: params.commandName,
      description: params.command.description,
      runExample: this.exampleRenderer.render(params.toolName, params.commandName, params.command),
      document: {
        id,
        fields: [
          { name: "command.id", value: id, weight: 12 },
          { name: "command.name", value: params.commandName, weight: 10 },
          { name: "tool.name", value: params.toolName, weight: 8 },
          { name: "command.description", value: params.command.description, weight: 7 },
          { name: "tool.description", value: params.toolDescription, weight: 5 },
          ...this.exampleFields(params.command.examples ?? []),
          ...this.inputFields(params.command.input),
        ],
      },
    };
  }

  private exampleFields(examples: ToolExample[]): ToolSearchDocument["fields"] {
    return examples.flatMap((example) => [
      { name: "example.title", value: example.title, weight: 4 },
      { name: "example.text", value: example.text, weight: 4 },
      ...(example.input === undefined
        ? []
        : [
            {
              name: "example.input",
              value: this.searchableValue(example.input),
              weight: 2,
            },
          ]),
    ]);
  }

  private inputFields(schema: unknown): ToolSearchDocument["fields"] {
    const jsonSchema = schemaRenderer.toJsonSchema(schema);
    return this.walkSchema({ schema: jsonSchema, path: [] });
  }

  private walkSchema(params: { schema: unknown; path: string[] }): ToolSearchDocument["fields"] {
    /* v8 ignore next -- schemaRenderer always returns a JSON Schema object */
    if (!this.isRecord(params.schema)) return [];
    const fields: ToolSearchDocument["fields"] = [];
    if (params.path.length > 0) {
      fields.push({ name: "input.field", value: params.path.join("."), weight: 3 });
    }
    if (typeof params.schema.description === "string") {
      fields.push({ name: "input.description", value: params.schema.description, weight: 3 });
    }
    if (Array.isArray(params.schema.enum)) {
      fields.push({ name: "input.enum", value: params.schema.enum.join(" "), weight: 1.5 });
    }
    if (this.isRecord(params.schema.properties)) {
      for (const [name, child] of Object.entries(params.schema.properties)) {
        fields.push(...this.walkSchema({ schema: child, path: [...params.path, name] }));
      }
    }
    if (params.schema.items !== undefined) {
      fields.push(...this.walkSchema({ schema: params.schema.items, path: params.path }));
    }
    return fields;
  }

  private searchableValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map((item) => this.searchableValue(item)).join(" ");
    if (this.isRecord(value)) {
      return Object.entries(value)
        .flatMap(([key, item]) => [key, this.searchableValue(item)])
        .join(" ");
    }
    return "";
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

class ToolFindPlainRendererClass {
  public render(params: { data: ToolFindData }): string {
    if (params.data.results.length === 0) {
      const scope = params.data.tool ? ` in tool ${params.data.tool}` : "";
      return `No Rig commands found for ${JSON.stringify(params.data.query)}${scope}.`;
    }
    return params.data.results
      .map((result) =>
        [
          `${result.rank}. ${result.id}`,
          `   ${result.description}`,
          `   ${this.oneLine({ value: result.runExample })}`,
        ].join("\n"),
      )
      .join("\n\n");
  }

  private oneLine(params: { value: string }): string {
    return params.value
      .replace(/\r\n/g, "\\n")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }
}

export class ToolFindServiceClass {
  private readonly discovery: ToolDiscoveryServiceClass;
  private readonly loader: ToolLoaderClass;
  private readonly metadata = new ToolFindMetadataClass();
  private readonly renderer = new ToolFindPlainRendererClass();

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryServiceClass(options);
    this.loader = new ToolLoaderClass(options);
  }

  public async find(params: { query: string; options?: ToolFindOptions }): Promise<ToolFindData> {
    const query = params.query.trim();
    if (!query) throw new RigErrorClass("INPUT_ERROR", "Find query cannot be empty.");
    const limit = this.limit(params.options?.limit);
    const tool = params.options?.tool ? new ToolNameClass(params.options.tool).value : undefined;
    const discovered = await this.discovery.discover();
    const selected = tool ? discovered.filter((entry) => entry.name === tool) : discovered;
    if (tool && selected.length === 0) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${tool}`, {
        available: discovered.map((entry) => entry.name),
      });
    }

    const searchable = (
      await Promise.all(
        selected.map(async (entry) => {
          const loaded = await this.loader.loadDiscovered(entry);
          return Object.entries(loaded.definition.commands).map(([commandName, command]) =>
            this.metadata.command({
              toolName: loaded.definition.name,
              toolDescription: loaded.definition.description,
              commandName,
              command,
            }),
          );
        }),
      )
    ).flat();
    const byId = new Map(searchable.map((command) => [command.id, command]));
    const ranked = toolSearchEngine.search({
      query,
      documents: searchable.map((command) => command.document),
      limit,
    });

    return {
      query,
      ...(tool ? { tool } : {}),
      limit,
      results: ranked.map((result, index) => {
        const command = byId.get(result.id)!;
        return {
          rank: index + 1,
          score: result.score,
          id: command.id,
          tool: command.tool,
          command: command.command,
          description: command.description,
          runExample: command.runExample,
          matches: result.matches,
        };
      }),
    };
  }

  public renderPlain(params: { data: ToolFindData }): string {
    return this.renderer.render(params);
  }

  private limit(value: number | string | undefined): number {
    const parsed = value === undefined ? 5 : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      throw new RigErrorClass("INPUT_ERROR", "Find limit must be an integer between 1 and 50.", {
        value,
      });
    }
    return parsed;
  }
}
