import { defineService, defineSingleton } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolDiscoveryServiceClass } from "../../registry/discover";
import { toolSearchEngine, type ToolSearchDocument } from "../domain/tool-search";
import { ToolNameClass } from "../identifiers";
import { commandIds, type ToolExample } from "../types";
import { ToolMetadataCacheClass, type ToolCommandMetadata } from "./tool-list";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchableValue(params: { value: unknown }): string {
  if (typeof params.value === "string") return params.value;
  if (typeof params.value === "number" || typeof params.value === "boolean") {
    return String(params.value);
  }
  if (Array.isArray(params.value)) {
    return params.value
      .map(function renderValue(item) {
        return searchableValue({ value: item });
      })
      .join(" ");
  }
  if (isRecord(params.value)) {
    return Object.entries(params.value)
      .flatMap(function renderEntry([key, item]) {
        return [key, searchableValue({ value: item })];
      })
      .join(" ");
  }
  return "";
}

function walkSchema(params: { schema: unknown; path: string[] }): ToolSearchDocument["fields"] {
  /* v8 ignore next -- schemaRenderer always returns a JSON Schema object */
  if (!isRecord(params.schema)) return [];
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
  if (isRecord(params.schema.properties)) {
    for (const [name, child] of Object.entries(params.schema.properties)) {
      fields.push(...walkSchema({ schema: child, path: [...params.path, name] }));
    }
  }
  if (params.schema.items !== undefined) {
    fields.push(...walkSchema({ schema: params.schema.items, path: params.path }));
  }
  return fields;
}

function exampleFields(params: { examples: ToolExample[] }): ToolSearchDocument["fields"] {
  return params.examples.flatMap(function renderExample(example) {
    return [
      { name: "example.title", value: example.title, weight: 4 },
      { name: "example.text", value: example.text, weight: 4 },
      ...(example.input === undefined
        ? []
        : [
            {
              name: "example.input",
              value: searchableValue({ value: example.input }),
              weight: 2,
            },
          ]),
    ];
  });
}

function metadataCommand(params: {
  toolName: string;
  toolDescription: string;
  commandName: string;
  command: ToolCommandMetadata;
}): SearchableCommand {
  const id = commandIds.from(params.toolName, params.commandName);
  return {
    id,
    tool: params.toolName,
    command: params.commandName,
    description: params.command.description,
    runExample: params.command.runExample,
    document: {
      id,
      fields: [
        { name: "command.id", value: id, weight: 12 },
        { name: "command.name", value: params.commandName, weight: 10 },
        { name: "tool.name", value: params.toolName, weight: 8 },
        { name: "command.description", value: params.command.description, weight: 7 },
        { name: "tool.description", value: params.toolDescription, weight: 5 },
        ...exampleFields({ examples: params.command.examples }),
        ...walkSchema({ schema: params.command.inputSchema, path: [] }),
      ],
    },
  };
}

export const ToolFindMetadataSingleton = defineSingleton({
  params: {},
  deps: {},
  command: metadataCommand,
});

function oneLine(params: { value: string }): string {
  return params.value
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function renderPlainFind(params: { data: ToolFindData }): string {
  if (params.data.results.length === 0) {
    const scope = params.data.tool ? ` in tool ${params.data.tool}` : "";
    return `No Rig commands found for ${JSON.stringify(params.data.query)}${scope}.`;
  }
  return params.data.results
    .map(function renderResult(result) {
      return [
        `${result.rank}. ${result.id}`,
        `   ${result.description}`,
        `   ${oneLine({ value: result.runExample })}`,
      ].join("\n");
    })
    .join("\n\n");
}

export const ToolFindPlainRendererSingleton = defineSingleton({
  params: {},
  deps: {},
  render: renderPlainFind,
});

function findLimit(params: { value: number | string | undefined }): number {
  const parsed = params.value === undefined ? 5 : Number(params.value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new RigErrorClass("INPUT_ERROR", "Find limit must be an integer between 1 and 50.", {
      value: params.value,
    });
  }
  return parsed;
}

type ToolFindServiceDeps = {
  discover: ToolDiscoveryServiceClass["discover"];
  loadMetadata: ToolMetadataCacheClass["load"];
};

function createToolFindServiceDeps(options: ConfigOptions): ToolFindServiceDeps {
  const discovery = new ToolDiscoveryServiceClass(options);
  const metadataCache = new ToolMetadataCacheClass(options);
  return {
    discover: discovery.discover.bind(discovery),
    loadMetadata: metadataCache.load.bind(metadataCache),
  };
}

const ToolFindServiceProductionDeps = createToolFindServiceDeps({});

export class ToolFindService extends defineService({
  params: {},
  deps: ToolFindServiceProductionDeps,
}) {
  public async find(params: { query: string; options?: ToolFindOptions }): Promise<ToolFindData> {
    const query = params.query.trim();
    if (!query) throw new RigErrorClass("INPUT_ERROR", "Find query cannot be empty.");
    const limit = findLimit({ value: params.options?.limit });
    const tool = params.options?.tool ? new ToolNameClass(params.options.tool).value : undefined;
    const discovered = await this.deps.discover();
    const selected = tool
      ? discovered.filter(function selectTool(entry) {
          return entry.name === tool;
        })
      : discovered;
    if (tool && selected.length === 0) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${tool}`, {
        available: discovered.map(function toolName(entry) {
          return entry.name;
        }),
      });
    }

    const loadedMetadata = await this.deps.loadMetadata(selected, { prune: tool === undefined });
    const searchable = loadedMetadata.flatMap(function searchableTool(loaded) {
      return loaded.commands.map(function searchableCommand(command) {
        return ToolFindMetadataSingleton.command({
          toolName: loaded.name,
          toolDescription: loaded.description,
          commandName: command.name,
          command,
        });
      });
    });
    const byId = new Map(
      searchable.map(function commandEntry(command) {
        return [command.id, command];
      }),
    );
    const ranked = toolSearchEngine.search({
      query,
      documents: searchable.map(function searchDocument(command) {
        return command.document;
      }),
      limit,
    });

    return {
      query,
      ...(tool ? { tool } : {}),
      limit,
      results: ranked.map(function rankedResult(result, index) {
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
    return ToolFindPlainRendererSingleton.render(params);
  }
}

export const ToolFind = new ToolFindService();

export type ToolFindServiceClass = {
  find(params: { query: string; options?: ToolFindOptions }): Promise<ToolFindData>;
  renderPlain(params: { data: ToolFindData }): string;
};

type ToolFindServiceConstructor = {
  new (options?: ConfigOptions): ToolFindServiceClass;
  readonly prototype: ToolFindServiceClass;
};

type ToolFindServiceAdapter = ToolFindServiceClass & { readonly resource: ToolFindService };

const ToolFindServiceClassAdapter = function constructToolFindService(
  this: ToolFindServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolFindService({ params: {}, deps: createToolFindServiceDeps(options) }),
  });
};
Object.defineProperty(ToolFindServiceClassAdapter, "name", { value: "ToolFindServiceClass" });
Object.defineProperties(ToolFindServiceClassAdapter.prototype, {
  find: {
    configurable: true,
    value: function find(
      this: ToolFindServiceAdapter,
      params: { query: string; options?: ToolFindOptions },
    ) {
      return this.resource.find(params);
    },
    writable: true,
  },
  renderPlain: {
    configurable: true,
    value: function renderPlain(this: ToolFindServiceAdapter, params: { data: ToolFindData }) {
      return this.resource.renderPlain(params);
    },
    writable: true,
  },
});

export const ToolFindServiceClass =
  ToolFindServiceClassAdapter as unknown as ToolFindServiceConstructor;
