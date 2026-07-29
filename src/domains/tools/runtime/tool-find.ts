import { Context, Effect, Layer, Predicate } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import { ToolIdentifierService } from "../service/tool-identifier";
import { ToolSearchService, type ToolSearchDocument } from "../service/tool-search";
import type { ToolExample } from "../types/tool-types";
import { type ToolCommandMetadata, type ToolMetadata, ToolMetadataCacheService } from "./tool-list";

export type ToolFindOptions = { limit?: number | string; tool?: string };
type ToolFindMatch = { field: string; value: string; score: number };
type ToolFindResult = {
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

type ParsedToolFindInput = { query: string; limit: number; tool?: string };

class ToolFindInputService extends Context.Service<
  ToolFindInputService,
  {
    readonly parse: (
      query: string,
      options?: ToolFindOptions,
    ) => Effect.Effect<ParsedToolFindInput, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolFindInputService", {
  make: Effect.gen(function* () {
    const normalizeError = (cause: unknown): RigError => {
      if (cause instanceof RigError) return cause;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    };
    const parseLimit = (value: number | string | undefined): number => {
      const parsed = value === undefined ? 5 : Number(value);
      const isInvalidLimit = !Number.isInteger(parsed) || parsed < 1 || parsed > 50;
      if (isInvalidLimit) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Find limit must be an integer between 1 and 50.",
          details: { value },
        });
      }
      return parsed;
    };
    const parse = Effect.fn("ToolFindInputService.parse")(function* (
      queryValue: string,
      options: ToolFindOptions = {},
    ) {
      return yield* Effect.try({
        try: () => {
          const query = queryValue.trim();
          if (!query) {
            throw new RigError({ code: "INPUT_ERROR", message: "Find query cannot be empty." });
          }
          return { query, limit: parseLimit(options.limit), tool: options.tool };
        },
        catch: normalizeError,
      });
    });
    return { parse } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolFindInputService, ToolFindInputService.make);
}

class ToolFindSchemaFieldsService extends Context.Service<
  ToolFindSchemaFieldsService,
  { readonly fields: (schema: unknown) => Effect.Effect<ToolSearchDocument["fields"]> }
>()("@rendotdev/rig/tools/presentation/ToolFindSchemaFieldsService", {
  make: Effect.gen(function* () {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const walk = (schema: unknown, path: string[]): ToolSearchDocument["fields"] => {
      /* v8 ignore next -- schemaRenderer always returns a JSON Schema object */
      if (!isRecord(schema)) return [];
      const fields: ToolSearchDocument["fields"] = [];
      if (path.length > 0) fields.push({ name: "input.field", value: path.join("."), weight: 3 });
      if (typeof schema.description === "string") {
        fields.push({ name: "input.description", value: schema.description, weight: 3 });
      }
      if (Array.isArray(schema.enum)) {
        fields.push({ name: "input.enum", value: schema.enum.join(" "), weight: 1.5 });
      }
      if (isRecord(schema.properties)) {
        for (const [name, child] of Object.entries(schema.properties)) {
          fields.push(...walk(child, [...path, name]));
        }
      }
      if (schema.items !== undefined) fields.push(...walk(schema.items, path));
      return fields;
    };
    const fields = Effect.fn("ToolFindSchemaFieldsService.fields")(function* (schema: unknown) {
      return walk(schema, []);
    });
    return { fields } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolFindSchemaFieldsService,
    ToolFindSchemaFieldsService.make,
  );
}

class ToolFindCommandIndexService extends Context.Service<
  ToolFindCommandIndexService,
  { readonly build: (metadata: ToolMetadata[]) => Effect.Effect<SearchableCommand[]> }
>()("@rendotdev/rig/tools/presentation/ToolFindCommandIndexService", {
  make: Effect.gen(function* () {
    const schemas = yield* ToolFindSchemaFieldsService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const searchableValue = (value: unknown): string => {
      if (typeof value === "string") return value;
      const isSearchableScalar = typeof value === "number" || typeof value === "boolean";
      if (isSearchableScalar) return String(value);
      if (Array.isArray(value)) return value.map(searchableValue).join(" ");
      if (isRecord(value)) {
        return Object.entries(value)
          .flatMap(([key, item]) => [key, searchableValue(item)])
          .join(" ");
      }
      return "";
    };
    const exampleFields = (examples: ToolExample[]): ToolSearchDocument["fields"] =>
      examples.flatMap((example) => [
        { name: "example.title", value: example.title, weight: 4 },
        { name: "example.text", value: example.text, weight: 4 },
        ...(example.input === undefined
          ? []
          : [{ name: "example.input", value: searchableValue(example.input), weight: 2 }]),
      ]);
    const command = Effect.fn("ToolFindCommandIndexService.command")(function* (
      toolName: string,
      toolDescription: string,
      commandValue: ToolCommandMetadata,
    ) {
      const id = `${toolName}.${commandValue.name}`;
      return {
        id,
        tool: toolName,
        command: commandValue.name,
        description: commandValue.description,
        runExample: commandValue.runExample,
        document: {
          id,
          fields: [
            { name: "command.id", value: id, weight: 12 },
            { name: "command.name", value: commandValue.name, weight: 10 },
            { name: "tool.name", value: toolName, weight: 8 },
            { name: "command.description", value: commandValue.description, weight: 7 },
            { name: "tool.description", value: toolDescription, weight: 5 },
            ...exampleFields(commandValue.examples),
            ...(yield* schemas.fields(commandValue.inputSchema)),
          ],
        },
      };
    });
    const build = Effect.fn("ToolFindCommandIndexService.build")(function* (
      metadata: ToolMetadata[],
    ) {
      return yield* Effect.forEach(metadata, (tool) =>
        Effect.forEach(tool.commands, (value) => command(tool.name, tool.description, value)),
      ).pipe(Effect.map((commands) => commands.flat()));
    });
    return { build } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolFindCommandIndexService,
    ToolFindCommandIndexService.make,
  );
}

class ToolFindRenderService extends Context.Service<
  ToolFindRenderService,
  { readonly render: (data: ToolFindData) => Effect.Effect<string> }
>()("@rendotdev/rig/tools/presentation/ToolFindRenderService", {
  make: Effect.gen(function* () {
    const oneLine = (value: string): string =>
      value
        .replace(/\r\n/g, "\\n")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    const render = Effect.fn("ToolFindRenderService.render")(function* (data: ToolFindData) {
      if (data.results.length === 0) {
        const scope = data.tool ? ` in tool ${data.tool}` : "";
        return `No Rig commands found for ${JSON.stringify(data.query)}${scope}.`;
      }
      return data.results
        .map((result) =>
          [
            `${result.rank}. ${result.id}`,
            `   ${result.description}`,
            `   ${oneLine(result.runExample)}`,
          ].join("\n"),
        )
        .join("\n\n");
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolFindRenderService, ToolFindRenderService.make);
}

export class ToolFindService extends Context.Service<
  ToolFindService,
  {
    readonly find: (
      query: string,
      options?: ToolFindOptions,
    ) => Effect.Effect<ToolFindData, RigError>;
    readonly render: (data: ToolFindData) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/presentation/ToolFindService", {
  make: Effect.gen(function* () {
    const input = yield* ToolFindInputService;
    const index = yield* ToolFindCommandIndexService;
    const renderer = yield* ToolFindRenderService;
    const discovery = yield* ToolDiscoveryService;
    const metadata = yield* ToolMetadataCacheService;
    const identifiers = yield* ToolIdentifierService;
    const search = yield* ToolSearchService;
    const render = Effect.fn("ToolFindService.render")(function* (data: ToolFindData) {
      return yield* renderer.render(data);
    });
    const find = Effect.fn("ToolFindService.find")(function* (
      queryValue: string,
      options: ToolFindOptions = {},
    ) {
      const { query, limit, tool } = yield* input.parse(queryValue, options);
      if (tool) yield* identifiers.parseToolName(tool);
      const discovered = yield* discovery.discover();
      const selected = tool ? discovered.filter((entry) => entry.name === tool) : discovered;
      const isSelectedToolMissing = tool && selected.length === 0;
      if (isSelectedToolMissing) {
        return yield* new RigError({
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${tool}`,
          details: { available: discovered.map((entry) => entry.name) },
        });
      }
      const commands = yield* index.build(
        yield* metadata.load(selected, { prune: tool === undefined }),
      );
      const byId = new Map(commands.map((command) => [command.id, command]));
      const ranked = yield* search.search({
        query,
        documents: commands.map((command) => command.document),
        limit,
      });
      return {
        query,
        ...(tool ? { tool } : {}),
        limit,
        results: ranked.map((result, rank) => {
          const command = byId.get(result.id)!;
          return {
            rank: rank + 1,
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
    });
    return { find, render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolFindService, ToolFindService.make);
}

const toolFindCommandIndexLayer = ToolFindCommandIndexService.layer.pipe(
  Layer.provide(ToolFindSchemaFieldsService.layer),
);
export const toolFindLayer = ToolFindService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ToolFindInputService.layer,
      toolFindCommandIndexLayer,
      ToolFindRenderService.layer,
    ),
  ),
);
