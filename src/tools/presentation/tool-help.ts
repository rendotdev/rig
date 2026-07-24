import type { ConfigOptions } from "../../config/config";
import { defineService, defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";
import type { CollectionDefinition } from "../collection";
import { commandTargets, ToolNameClass } from "../identifiers";
import { ToolLoaderClass } from "../loader";
import { schemaRenderer } from "../schema";
import { commandIds, type CommandDefinition, type ToolDefinition } from "../types";

type ToolDefinitionWithCollections = {
  collections?: Record<string, CollectionDefinition | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function helpTypeName(params: { schema: unknown }): string {
  if (!isRecord(params.schema)) return "unknown";
  const type = params.schema.type;
  if (Array.isArray(type)) return type.join(" | ");
  if (typeof type === "string") return type;
  return "unknown";
}

function renderFields(params: { schema: unknown }): string {
  const jsonSchema = schemaRenderer.toJsonSchema(params.schema);
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema.properties)) {
    return "- value: unknown";
  }

  const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  const fields = Object.entries(jsonSchema.properties).map(function renderField([name, property]) {
    const hasDefault = isRecord(property) && property.default !== undefined;
    const requiredText = required.includes(name) && !hasDefault ? "required" : "optional";
    const defaultText = hasDefault ? `, default ${JSON.stringify(property.default)}` : "";
    return `- ${name}: ${helpTypeName({ schema: property })} (${requiredText}${defaultText})`;
  });

  return fields.join("\n");
}

function shellArg(params: { value: string }): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(params.value)) return params.value;
  return `'${params.value.replaceAll("'", "'\\''")}'`;
}

function renderHelpExampleArgs(params: { input: unknown }): string {
  if (!isRecord(params.input)) return shellArg({ value: String(params.input) });
  const entries = Object.entries(params.input);
  if (entries.length === 1) return shellArg({ value: String(entries[0]?.[1]) });
  return entries
    .map(function renderEntry([key, value]) {
      return `${key}=${shellArg({ value: String(value) })}`;
    })
    .join(" ");
}

function renderExamples(params: {
  toolName: string;
  commandName: string;
  command: CommandDefinition;
}): string {
  const examples = params.command.examples ?? [];
  if (examples.length === 0) return "No examples declared.";

  return examples
    .map(function renderExample(example) {
      const args =
        example.input === undefined ? "" : ` ${renderHelpExampleArgs({ input: example.input })}`;
      return [
        `$ rig run ${commandIds.from(params.toolName, params.commandName)}${args}`,
        `# ${example.title}: ${example.text}`,
      ].join("\n");
    })
    .join("\n\n");
}

function renderHelpCommand(params: {
  toolName: string;
  commandName: string;
  command: CommandDefinition;
  options?: { detailed?: boolean; headingLevel?: number };
}): string {
  const options = params.options ?? {};
  const id = commandIds.from(params.toolName, params.commandName);
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
    renderFields({ schema: params.command.input }),
    "",
    "Output:",
    "",
    renderFields({ schema: params.command.output }),
    "",
    "Examples:",
    "",
    renderExamples(params),
  );

  return lines.join("\n");
}

/* v8 ignore start */
function renderCollection(params: {
  name: string;
  definition: CollectionDefinition | undefined;
}): string {
  const lines = [`### ${params.name}`, "", `Directory: <tool>/${params.name}/`];
  lines.push(`Access: context.collections.${params.name}`);
  if (params.definition?.schema) {
    lines.push("", "Schema:", "", renderFields({ schema: params.definition.schema }));
  } else {
    lines.push("", "Schema: (none, any frontmatter allowed)");
  }
  return lines.join("\n");
}
/* v8 ignore stop */

function renderToolHelp(params: { definition: ToolDefinition; selectedCommand?: string }): string {
  if (params.selectedCommand) {
    const command = params.definition.commands[params.selectedCommand];
    if (!command) {
      throw new RigErrorClass(
        "COMMAND_NOT_FOUND",
        `Command not found: ${commandIds.from(params.definition.name, params.selectedCommand)}`,
        { available: Object.keys(params.definition.commands) },
      );
    }
    return renderHelpCommand({
      toolName: params.definition.name,
      commandName: params.selectedCommand,
      command,
      options: { detailed: true, headingLevel: 1 },
    });
  }

  const lines = [`# ${params.definition.name}`, "", params.definition.description, ""];

  /* v8 ignore start */
  const collections = (params.definition as ToolDefinitionWithCollections).collections;
  if (collections && Object.keys(collections).length > 0) {
    lines.push("## Collections", "");
    for (const [name, definition] of Object.entries(collections)) {
      lines.push(renderCollection({ name, definition }), "");
    }
  }
  /* v8 ignore stop */

  lines.push("## Commands", "");
  for (const [commandName, command] of Object.entries(params.definition.commands)) {
    lines.push(
      renderHelpCommand({
        toolName: params.definition.name,
        commandName,
        command,
        options: { headingLevel: 3 },
      }),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

export const ToolHelpRendererSingleton = defineSingleton({
  params: {},
  deps: {},
  render: renderToolHelp,
  renderCommand: renderHelpCommand,
  renderExampleArgs: renderHelpExampleArgs,
  typeName: helpTypeName,
});

export type ToolHelpRendererClass = {
  render(definition: ToolDefinition, selectedCommand?: string): string;
};

type ToolHelpRendererConstructor = {
  new (): ToolHelpRendererClass;
  readonly prototype: ToolHelpRendererClass;
};

type ToolHelpRendererAdapter = ToolHelpRendererClass & {
  renderCommand(toolName: string, commandName: string, command: CommandDefinition): string;
  renderExampleArgs(input: unknown): string;
  typeName(schema: unknown): string;
};

const ToolHelpRendererClassAdapter = function constructToolHelpRenderer(): void {};
Object.defineProperty(ToolHelpRendererClassAdapter, "name", { value: "ToolHelpRendererClass" });
Object.defineProperties(ToolHelpRendererClassAdapter.prototype, {
  render: {
    configurable: true,
    value: function render(
      this: ToolHelpRendererAdapter,
      definition: ToolDefinition,
      selectedCommand?: string,
    ) {
      return ToolHelpRendererSingleton.render({ definition, selectedCommand });
    },
    writable: true,
  },
  renderCommand: {
    configurable: true,
    value: function renderLegacyCommand(
      this: ToolHelpRendererAdapter,
      toolName: string,
      commandName: string,
      command: CommandDefinition,
    ) {
      return ToolHelpRendererSingleton.renderCommand({ toolName, commandName, command });
    },
    writable: true,
  },
  renderExampleArgs: {
    configurable: true,
    value: function renderLegacyExampleArgs(this: ToolHelpRendererAdapter, input: unknown) {
      return ToolHelpRendererSingleton.renderExampleArgs({ input });
    },
    writable: true,
  },
  typeName: {
    configurable: true,
    value: function legacyTypeName(this: ToolHelpRendererAdapter, schema: unknown) {
      return ToolHelpRendererSingleton.typeName({ schema });
    },
    writable: true,
  },
});

export const ToolHelpRendererClass =
  ToolHelpRendererClassAdapter as unknown as ToolHelpRendererConstructor;

function helpTarget(params: { toolName: string; commandName?: string }): {
  toolName: string;
  commandName?: string;
} {
  if (params.commandName) {
    const target = commandTargets.from(params.toolName, params.commandName);
    return { toolName: target.tool, commandName: target.command };
  }
  if (!params.toolName.includes(".")) {
    return { toolName: new ToolNameClass(params.toolName).value };
  }
  const target = commandTargets.parse(params.toolName);
  return { toolName: target.tool, commandName: target.command };
}

type ToolHelpServiceDeps = {
  loadDefinition: ToolLoaderClass["loadDefinition"];
  render: typeof ToolHelpRendererSingleton.render;
};

function createToolHelpServiceDeps(options: ConfigOptions): ToolHelpServiceDeps {
  const loader = new ToolLoaderClass(options);
  return {
    loadDefinition: loader.loadDefinition.bind(loader),
    render: ToolHelpRendererSingleton.render,
  };
}

const ToolHelpServiceProductionDeps = createToolHelpServiceDeps({});

export class ToolHelpService extends defineService({
  params: {},
  deps: ToolHelpServiceProductionDeps,
}) {
  public async render(params: { toolName: string; commandName?: string }): Promise<string> {
    const target = helpTarget(params);
    const tool = await this.deps.loadDefinition(target.toolName);
    return this.deps.render({
      definition: tool.definition,
      selectedCommand: target.commandName,
    });
  }
}

export const ToolHelp = new ToolHelpService();

export type ToolHelpServiceClass = {
  render(toolName: string, commandName?: string): Promise<string>;
};

type ToolHelpServiceConstructor = {
  new (options?: ConfigOptions): ToolHelpServiceClass;
  readonly prototype: ToolHelpServiceClass;
};

type ToolHelpServiceAdapter = ToolHelpServiceClass & { readonly resource: ToolHelpService };

const ToolHelpServiceClassAdapter = function constructToolHelpService(
  this: ToolHelpServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolHelpService({ params: {}, deps: createToolHelpServiceDeps(options) }),
  });
};
Object.defineProperty(ToolHelpServiceClassAdapter, "name", { value: "ToolHelpServiceClass" });
Object.defineProperty(ToolHelpServiceClassAdapter.prototype, "render", {
  configurable: true,
  value: function render(this: ToolHelpServiceAdapter, toolName: string, commandName?: string) {
    return this.resource.render({ toolName, commandName });
  },
  writable: true,
});

export const ToolHelpServiceClass =
  ToolHelpServiceClassAdapter as unknown as ToolHelpServiceConstructor;
