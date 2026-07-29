import { Context, Effect, Layer, Predicate } from "effect";
import type { CollectionDefinition } from "../../collections/types/tool-collection";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolIdentifierService } from "../service/tool-identifier";
import { SchemaRendererService } from "../service/schema-renderer";
import type { CommandDefinition, ToolDefinition } from "../types/tool-types";
import { ToolLoaderService } from "./tool-loader";

type ToolDefinitionWithCollections = {
  collections?: Record<string, CollectionDefinition | undefined>;
};

class ToolHelpSchemaService extends Context.Service<
  ToolHelpSchemaService,
  { readonly renderFields: (schema: unknown) => Effect.Effect<string> }
>()("@rendotdev/rig/tools/presentation/ToolHelpSchemaService", {
  make: Effect.gen(function* () {
    const schemas = yield* SchemaRendererService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const typeName = (schema: unknown): string => {
      if (!isRecord(schema)) return "unknown";
      if (Array.isArray(schema.type)) return schema.type.join(" | ");
      return typeof schema.type === "string" ? schema.type : "unknown";
    };
    const renderFields = Effect.fn("ToolHelpSchemaService.renderFields")(function* (
      schema: unknown,
    ) {
      const jsonSchema = yield* schemas.renderJson(schema);
      const hasNoObjectProperties = !isRecord(jsonSchema) || !isRecord(jsonSchema.properties);
      if (hasNoObjectProperties) return "- value: unknown";
      const schemaRecord = jsonSchema as Record<string, unknown>;
      const properties = schemaRecord.properties as Record<string, unknown>;
      const required = Array.isArray(schemaRecord.required) ? schemaRecord.required : [];
      return Object.entries(properties)
        .map(([name, property]) => {
          const hasDefault = isRecord(property) && property.default !== undefined;
          const requiredText = required.includes(name) && !hasDefault ? "required" : "optional";
          const defaultText = hasDefault ? `, default ${JSON.stringify(property.default)}` : "";
          return `- ${name}: ${typeName(property)} (${requiredText}${defaultText})`;
        })
        .join("\n");
    });
    return { renderFields } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolHelpSchemaService, ToolHelpSchemaService.make);
}

class ToolHelpExampleService extends Context.Service<
  ToolHelpExampleService,
  {
    readonly render: (
      toolName: string,
      commandName: string,
      command: CommandDefinition,
    ) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolHelpExampleService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const shellArg = (value: string): string =>
      /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
    const renderArgs = (input: unknown): string => {
      if (!isRecord(input)) return shellArg(String(input));
      const entries = Object.entries(input);
      if (entries.length === 1) return shellArg(String(entries[0]?.[1]));
      return entries.map(([key, value]) => `${key}=${shellArg(String(value))}`).join(" ");
    };
    const render = Effect.fn("ToolHelpExampleService.render")(function* (
      toolName: string,
      commandName: string,
      command: CommandDefinition,
    ) {
      const examples = command.examples ?? [];
      if (examples.length === 0) return "No examples declared.";
      const id = yield* identifiers.commandId(toolName, commandName);
      return examples
        .map((example) => {
          const args = example.input === undefined ? "" : ` ${renderArgs(example.input)}`;
          return [`$ rig run ${id}${args}`, `# ${example.title}: ${example.text}`].join("\n");
        })
        .join("\n\n");
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolHelpExampleService, ToolHelpExampleService.make);
}

class ToolHelpCommandService extends Context.Service<
  ToolHelpCommandService,
  {
    readonly render: (params: {
      toolName: string;
      commandName: string;
      command: CommandDefinition;
      options?: { detailed?: boolean; headingLevel?: number };
    }) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolHelpCommandService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const schemas = yield* ToolHelpSchemaService;
    const examples = yield* ToolHelpExampleService;
    const render = Effect.fn("ToolHelpCommandService.render")(function* (params: {
      toolName: string;
      commandName: string;
      command: CommandDefinition;
      options?: { detailed?: boolean; headingLevel?: number };
    }) {
      const options = params.options ?? {};
      const id = yield* identifiers.commandId(params.toolName, params.commandName);
      const heading = "#".repeat(options.headingLevel ?? 3);
      const lines = options.detailed
        ? [
            `Tool: ${params.toolName}`,
            `Command: ${params.commandName}`,
            `Run: rig run ${id} [args...]`,
            "",
          ]
        : [`${heading} ${id}`, "", `Run: rig run ${id} [args...]`, ""];
      if (options.detailed) lines.push(`${heading} ${id}`, "");
      lines.push(
        params.command.description,
        "",
        "Input:",
        "",
        yield* schemas.renderFields(params.command.input),
        "",
        "Output:",
        "",
        yield* schemas.renderFields(params.command.output),
        "",
        "Examples:",
        "",
        yield* examples.render(params.toolName, params.commandName, params.command),
      );
      return lines.join("\n");
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolHelpCommandService, ToolHelpCommandService.make);
}

class ToolHelpDocumentService extends Context.Service<
  ToolHelpDocumentService,
  {
    readonly render: (
      definition: ToolDefinition,
      selectedCommand?: string,
    ) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolHelpDocumentService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const schemas = yield* ToolHelpSchemaService;
    const commands = yield* ToolHelpCommandService;
    const renderCollection = Effect.fn("ToolHelpDocumentService.renderCollection")(function* (
      name: string,
      definition: CollectionDefinition | undefined,
    ) {
      const lines = [
        `### ${name}`,
        "",
        `Directory: <tool>/${name}/`,
        `Access: context.collections.${name}`,
      ];
      if (definition?.schema) {
        lines.push("", "Schema:", "", yield* schemas.renderFields(definition.schema));
      } else {
        lines.push("", "Schema: (none, any frontmatter allowed)");
      }
      return lines.join("\n");
    });
    const render = Effect.fn("ToolHelpDocumentService.render")(function* (
      definition: ToolDefinition,
      selectedCommand?: string,
    ) {
      if (selectedCommand) {
        const command = definition.commands[selectedCommand];
        if (!command) {
          return yield* new RigError({
            code: "COMMAND_NOT_FOUND",
            message: `Command not found: ${yield* identifiers.commandId(definition.name, selectedCommand)}`,
            details: { available: Object.keys(definition.commands) },
          });
        }
        return yield* commands.render({
          toolName: definition.name,
          commandName: selectedCommand,
          command,
          options: { detailed: true, headingLevel: 1 },
        });
      }
      const lines = [`# ${definition.name}`, "", definition.description, ""];
      const collections = (definition as ToolDefinitionWithCollections).collections;
      const hasCollections = collections && Object.keys(collections).length > 0;
      if (hasCollections) {
        lines.push("## Collections", "");
        for (const [name, collection] of Object.entries(collections)) {
          lines.push(yield* renderCollection(name, collection), "");
        }
      }
      lines.push("## Commands", "");
      for (const [commandName, command] of Object.entries(definition.commands)) {
        lines.push(
          yield* commands.render({
            toolName: definition.name,
            commandName,
            command,
            options: { headingLevel: 3 },
          }),
          "",
        );
      }
      return lines.join("\n").trimEnd();
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolHelpDocumentService, ToolHelpDocumentService.make);
}

export class ToolHelpService extends Context.Service<
  ToolHelpService,
  {
    readonly render: (toolName: string, commandName?: string) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolHelpService", {
  make: Effect.gen(function* () {
    const loader = yield* ToolLoaderService;
    const identifiers = yield* ToolIdentifierService;
    const documents = yield* ToolHelpDocumentService;
    const helpTarget = Effect.fn("ToolHelpService.helpTarget")(function* (
      toolName: string,
      commandName?: string,
    ) {
      if (commandName) {
        const target = yield* identifiers.makeCommandTarget(toolName, commandName);
        return { toolName: target.tool, commandName: target.command };
      }
      if (!toolName.includes(".")) {
        return { toolName: (yield* identifiers.parseToolName(toolName)).value };
      }
      const target = yield* identifiers.parseCommandTarget(toolName);
      return { toolName: target.tool, commandName: target.command };
    });
    const render = Effect.fn("ToolHelpService.render")(function* (
      toolName: string,
      commandName?: string,
    ) {
      const target = yield* helpTarget(toolName, commandName);
      const tool = yield* loader.loadDefinition(target.toolName);
      return yield* documents.render(tool.definition, target.commandName);
    });
    return { render } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolHelpService, ToolHelpService.make);
}

const toolHelpSchemaLayer = ToolHelpSchemaService.layer.pipe(
  Layer.provide(SchemaRendererService.layer),
);
const toolHelpExampleLayer = ToolHelpExampleService.layer.pipe(
  Layer.provide(ToolIdentifierService.layer),
);
const toolHelpCommandLayer = ToolHelpCommandService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ToolIdentifierService.layer, toolHelpSchemaLayer, toolHelpExampleLayer),
  ),
);
const toolHelpDocumentLayer = ToolHelpDocumentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ToolIdentifierService.layer, toolHelpSchemaLayer, toolHelpCommandLayer),
  ),
);
export const toolHelpLayer = ToolHelpService.layer.pipe(
  Layer.provide(Layer.merge(ToolIdentifierService.layer, toolHelpDocumentLayer)),
);
