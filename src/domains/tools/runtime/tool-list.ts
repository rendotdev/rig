import { readFile, stat } from "node:fs/promises";
import { Context, Effect, Layer, Predicate } from "effect";
import type { CollectionDefinition } from "../../collections/types/tool-collection";
import { AtomicFileWriterService } from "../../../providers/filesystem/atomic-file-writer";
import { RigPathsConfigService } from "../../../providers/paths/rig-paths";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { ToolIdentifierService } from "../service/tool-identifier";
import { SchemaRendererService } from "../service/schema-renderer";
import { CurrentRigToolApiVersion } from "../config/tool-api";
import type { CommandDefinition, ToolExample } from "../types/tool-types";
import { ToolLoaderService, type LoadedToolDefinition } from "./tool-loader";

export type ToolListOptions = { visibleFromPath?: string };
type ListedCommand = {
  name: string;
  id: string;
  description: string;
  runExample: string;
  helpExample: string;
};
type ListedCollection = { name: string; hasSchema: boolean };
type ListedTool = {
  name: string;
  description: string;
  registryKind: string;
  registryPath: string;
  toolPath: string;
  commands: ListedCommand[];
  collections: ListedCollection[];
};
export type ToolListData = { tools: ListedTool[]; visibleFromPath?: string };
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
type ToolMetadataCacheTimes = { modifiedAtMs: number; changedAtMs: number };
type ToolMetadataCacheEntry = ToolMetadataCacheTimes & { size: number; metadata: ToolMetadata };
type MetadataCacheHeader = { version: 1; toolApiVersion: number };
type ToolMetadataCache = MetadataCacheHeader & { entries: Record<string, ToolMetadataCacheEntry> };

class ToolMetadataExampleService extends Context.Service<
  ToolMetadataExampleService,
  {
    readonly render: (
      toolName: string,
      commandName: string,
      command: CommandDefinition,
    ) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolMetadataExampleService", {
  make: Effect.gen(function* () {
    const schemas = yield* SchemaRendererService;
    const identifiers = yield* ToolIdentifierService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const shellArg = (value: string): string =>
      /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
    const placeholder = (schema: unknown): string => {
      if (!isRecord(schema)) return "VALUE";
      const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
      const isNumericType = type === "number" || type === "integer";
      if (isNumericType) return "0";
      if (type === "boolean") return "true";
      if (type === "array") return "[]";
      if (type === "object") return "{}";
      return "VALUE";
    };
    const renderRequiredInput = Effect.fn("ToolMetadataExampleService.renderRequiredInput")(
      function* (schema: unknown) {
        const jsonSchema = yield* schemas.renderJson(schema);
        const hasNoObjectProperties = !isRecord(jsonSchema) || !isRecord(jsonSchema.properties);
        if (hasNoObjectProperties) return "";
        const schemaRecord = jsonSchema as Record<string, unknown>;
        const properties = schemaRecord.properties as Record<string, unknown>;
        const required = Array.isArray(schemaRecord.required) ? schemaRecord.required : [];
        const fields = Object.entries(properties)
          .filter(
            ([name, property]) =>
              required.includes(name) && !(isRecord(property) && property.default !== undefined),
          )
          .map(([name, property]) => [name, placeholder(property)] as const);
        if (fields.length === 0) return "";
        if (fields.length <= 3) {
          return fields.map(([name, value]) => `${name}=${shellArg(value)}`).join(" ");
        }
        return `--input ${shellArg(JSON.stringify(Object.fromEntries(fields)))}`;
      },
    );
    const inputScalar = (value: unknown): string =>
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    const renderInput = (input: unknown): string => {
      if (!isRecord(input)) return shellArg(String(input));
      return Object.entries(input)
        .map(([key, value]) => `${key}=${shellArg(inputScalar(value))}`)
        .join(" ");
    };
    const render = Effect.fn("ToolMetadataExampleService.render")(function* (
      toolName: string,
      commandName: string,
      command: CommandDefinition,
    ) {
      const id = yield* identifiers.commandId(toolName, commandName);
      const exampleInput = command.examples?.find((example) => example.input !== undefined)?.input;
      if (exampleInput !== undefined) {
        return `rig run ${id} ${renderInput(exampleInput)}`.trimEnd();
      }
      const args = yield* renderRequiredInput(command.input);
      return `rig run ${id}${args ? ` ${args}` : ""}`;
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolMetadataExampleService, ToolMetadataExampleService.make);
}

class ToolMetadataBuilderService extends Context.Service<
  ToolMetadataBuilderService,
  { readonly build: (loaded: LoadedToolDefinition) => Effect.Effect<ToolMetadata, RigError> }
>()("@rendotdev/rig/tools/presentation/ToolMetadataBuilderService", {
  make: Effect.gen(function* () {
    const schemas = yield* SchemaRendererService;
    const examples = yield* ToolMetadataExampleService;
    const listedCollections = (loaded: LoadedToolDefinition): ListedCollection[] => {
      const collections =
        (
          loaded.definition as LoadedToolDefinition["definition"] & {
            collections?: Record<string, CollectionDefinition | undefined>;
          }
        ).collections ?? {};
      return Object.entries(collections).map(([name, value]) => ({
        name,
        hasSchema: Boolean(value?.schema),
      }));
    };
    const buildCommand = Effect.fn("ToolMetadataBuilderService.buildCommand")(function* (
      toolName: string,
      name: string,
      command: CommandDefinition,
    ) {
      return {
        name,
        description: command.description,
        inputSchema: yield* schemas.renderJson(command.input),
        outputSchema: yield* schemas.renderJson(command.output),
        examples: command.examples ?? [],
        runExample: yield* examples.render(toolName, name, command),
      };
    });
    const build = Effect.fn("ToolMetadataBuilderService.build")(function* (
      loaded: LoadedToolDefinition,
    ) {
      const commands = yield* Effect.all(
        Object.entries(loaded.definition.commands).map(([name, command]) =>
          buildCommand(loaded.definition.name, name, command),
        ),
      );
      return {
        name: loaded.definition.name,
        description: loaded.definition.description,
        commands,
        collections: listedCollections(loaded),
      };
    });
    return { build } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolMetadataBuilderService, ToolMetadataBuilderService.make);
}

class ToolMetadataCacheFileService extends Context.Service<
  ToolMetadataCacheFileService,
  {
    readonly read: Effect.Effect<ToolMetadataCache>;
    readonly write: (cache: ToolMetadataCache) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/tools/presentation/ToolMetadataCacheFileService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const writer = yield* AtomicFileWriterService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const emptyCache = (): ToolMetadataCache => ({
      version: 1,
      toolApiVersion: CurrentRigToolApiVersion,
      entries: {},
    });
    const read = Effect.tryPromise({
      try: async () => {
        const value =
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? await Bun.file(paths.toolMetadataCachePath).json()
            : JSON.parse(await readFile(paths.toolMetadataCachePath, "utf8"));
        const hasInvalidCacheEnvelope = !isRecord(value) || value.version !== 1;
        if (hasInvalidCacheEnvelope) return emptyCache();
        const hasIncompatibleCacheContent =
          value.toolApiVersion !== CurrentRigToolApiVersion || !isRecord(value.entries);
        if (hasIncompatibleCacheContent) {
          return emptyCache();
        }
        return value as ToolMetadataCache;
      },
      catch: () => emptyCache(),
    }).pipe(Effect.orElseSucceed(emptyCache), Effect.withSpan("ToolMetadataCacheFileService.read"));
    const write = Effect.fn("ToolMetadataCacheFileService.write")(function* (
      cache: ToolMetadataCache,
    ) {
      yield* writer
        .write(paths.toolMetadataCachePath, `${JSON.stringify(cache, null, 2)}\n`)
        .pipe(Effect.ignore);
    });
    return { read, write } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolMetadataCacheFileService,
    ToolMetadataCacheFileService.make,
  );
}

export class ToolMetadataCacheService extends Context.Service<
  ToolMetadataCacheService,
  {
    readonly load: (
      entries: DiscoveredTool[],
      options?: { prune?: boolean },
    ) => Effect.Effect<ToolMetadata[], RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolMetadataCacheService", {
  make: Effect.gen(function* () {
    const loader = yield* ToolLoaderService;
    const builders = yield* ToolMetadataBuilderService;
    const files = yield* ToolMetadataCacheFileService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const isMetadata = (value: unknown): value is ToolMetadata =>
      Predicate.isObject(value) &&
      !Array.isArray(value) &&
      typeof value.name === "string" &&
      typeof value.description === "string" &&
      Array.isArray(value.commands) &&
      Array.isArray(value.collections);
    const loadEntry = Effect.fn("ToolMetadataCacheService.loadEntry")(function* (params: {
      entry: DiscoveredTool;
      current: ToolMetadataCache;
      nextEntries: Record<string, ToolMetadataCacheEntry>;
      changed: { value: boolean };
    }) {
      const status = yield* Effect.tryPromise({
        try: () => stat(params.entry.toolPath),
        catch: toError,
      });
      const cached = params.current.entries[params.entry.toolPath];
      const isCurrentCacheEntry =
        cached?.modifiedAtMs === status.mtimeMs &&
        cached.changedAtMs === status.ctimeMs &&
        cached.size === status.size &&
        isMetadata(cached.metadata);
      if (isCurrentCacheEntry) {
        params.nextEntries[params.entry.toolPath] = cached;
        return cached.metadata;
      }
      params.changed.value = true;
      const value = yield* builders.build(yield* loader.loadDefinitionDiscovered(params.entry));
      params.nextEntries[params.entry.toolPath] = {
        modifiedAtMs: status.mtimeMs,
        changedAtMs: status.ctimeMs,
        size: status.size,
        metadata: value,
      };
      return value;
    });
    const load = Effect.fn("ToolMetadataCacheService.load")(function* (
      entries: DiscoveredTool[],
      options: { prune?: boolean } = {},
    ) {
      const current = yield* files.read;
      const nextEntries: Record<string, ToolMetadataCacheEntry> =
        options.prune === false ? { ...current.entries } : {};
      const changed = { value: false };
      const metadata = yield* Effect.all(
        entries.map((entry) => loadEntry({ entry, current, nextEntries, changed })),
        { concurrency: "unbounded" },
      );
      const pruned =
        options.prune !== false && Object.keys(current.entries).some((path) => !nextEntries[path]);
      const shouldWriteCache = changed.value || pruned;
      if (shouldWriteCache) {
        yield* files.write({
          version: 1,
          toolApiVersion: CurrentRigToolApiVersion,
          entries: nextEntries,
        });
      }
      return metadata;
    });
    return { load } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolMetadataCacheService, ToolMetadataCacheService.make);
}

export class ToolListService extends Context.Service<
  ToolListService,
  {
    readonly list: (options?: ToolListOptions) => Effect.Effect<ToolListData, RigError>;
    readonly renderPlain: (data: ToolListData) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/presentation/ToolListService", {
  make: Effect.gen(function* () {
    const discovery = yield* ToolDiscoveryService;
    const metadataCache = yield* ToolMetadataCacheService;
    const identifiers = yield* ToolIdentifierService;
    const plainDescription = (value: string): string => value.replace(/\s+/g, " ").trim();
    const plainExample = (value: string): string =>
      value
        .replace(/\r\n/g, "\\n")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        .trim();
    const listedTool = Effect.fn("ToolListService.listedTool")(function* (
      entry: DiscoveredTool,
      tool: ToolMetadata,
    ) {
      const commands = yield* Effect.all(
        tool.commands.map((command) =>
          identifiers.commandId(tool.name, command.name).pipe(
            Effect.map((id) => ({
              name: command.name,
              id,
              description: command.description,
              runExample: command.runExample,
              helpExample: `rig help ${id}`,
            })),
          ),
        ),
      );
      return {
        name: tool.name,
        description: tool.description,
        registryKind: entry.registryKind,
        registryPath: entry.registryPath,
        toolPath: entry.toolPath,
        commands,
        collections: tool.collections,
      };
    });
    const list = Effect.fn("ToolListService.list")(function* (options: ToolListOptions = {}) {
      const discovered = yield* discovery.discover({ visibleFromPath: options.visibleFromPath });
      const metadata = yield* metadataCache.load(discovered);
      return {
        tools: yield* Effect.all(
          discovered.map((entry, index) => listedTool(entry, metadata[index]!)),
        ),
        visibleFromPath: options.visibleFromPath,
      };
    });
    const renderPlain = Effect.fn("ToolListService.renderPlain")(function* (data: ToolListData) {
      if (data.tools.length === 0) return "No Rig tools found.";
      return data.tools
        .map((tool) => {
          const collections =
            tool.collections.length > 0
              ? ` [collections: ${tool.collections.map((item) => item.name).join(", ")}]`
              : "";
          return [
            `${tool.name} # ${plainDescription(tool.description)}${collections}`,
            ...tool.commands.map(
              (command) =>
                `  ${plainExample(command.runExample)} # ${plainDescription(command.description)}`,
            ),
          ].join("\n");
        })
        .join("\n\n");
    });
    return { list, renderPlain } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolListService, ToolListService.make);
}

const toolMetadataExampleLayer = ToolMetadataExampleService.layer;
const toolMetadataBuilderLayer = ToolMetadataBuilderService.layer.pipe(
  Layer.provide(toolMetadataExampleLayer),
);
export const toolMetadataCacheLayer = ToolMetadataCacheService.layer.pipe(
  Layer.provide(Layer.merge(toolMetadataBuilderLayer, ToolMetadataCacheFileService.layer)),
);
export const toolListLayer = ToolListService.layer;
