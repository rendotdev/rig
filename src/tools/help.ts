import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { ToolLoader } from "./loader";
import { SchemaRenderer } from "./schema";
import { CommandIds, type CommandDefinition, type ToolDefinition } from "./types";

export class ToolHelpRenderer {
  render(definition: ToolDefinition, selectedCommand?: string): string {
    if (selectedCommand) {
      const command = definition.commands[selectedCommand];
      if (!command) {
        throw new RigError(
          "COMMAND_NOT_FOUND",
          `Command not found: ${CommandIds.from(definition.name, selectedCommand)}`,
          {
            available: Object.keys(definition.commands),
          },
        );
      }
      return this.renderCommand(definition.name, selectedCommand, command, {
        detailed: true,
        headingLevel: 1,
      });
    }

    const lines = [`# ${definition.name}`, "", definition.description, "", "## Commands", ""];
    for (const [commandName, command] of Object.entries(definition.commands)) {
      lines.push(
        this.renderCommand(definition.name, commandName, command, { headingLevel: 3 }),
        "",
      );
    }
    return lines.join("\n").trimEnd();
  }

  private renderCommand(
    toolName: string,
    commandName: string,
    command: CommandDefinition,
    options: { detailed?: boolean; headingLevel?: number } = {},
  ): string {
    const id = CommandIds.from(toolName, commandName);
    const heading = "#".repeat(options.headingLevel ?? 3);
    const lines = options.detailed
      ? [`Tool: ${toolName}`, `Command: ${commandName}`, `Run: rig run ${id} [args...]`, ""]
      : [`${heading} ${id}`, "", `Run: rig run ${id} [args...]`, ""];

    if (options.detailed) lines.push(`${heading} ${id}`, "");

    lines.push(
      command.description,
      "",
      "Input:",
      "",
      this.renderFields(command.input),
      "",
      "Output:",
      "",
      this.renderFields(command.output),
      "",
      "Examples:",
      "",
      this.renderExamples(toolName, commandName, command),
    );

    return lines.join("\n");
  }

  private renderFields(schema: unknown): string {
    const jsonSchema = SchemaRenderer.toJsonSchema(schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) {
      return "- value: unknown";
    }

    const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
    const fields = Object.entries(jsonSchema.properties).map(([name, property]) => {
      const hasDefault = this.isRecord(property) && property.default !== undefined;
      const requiredText = required.includes(name) && !hasDefault ? "required" : "optional";
      const defaultText = hasDefault ? `, default ${JSON.stringify(property.default)}` : "";
      return `- ${name}: ${this.typeName(property)} (${requiredText}${defaultText})`;
    });

    return fields.join("\n");
  }

  private typeName(schema: unknown): string {
    if (!this.isRecord(schema)) return "unknown";
    const type = schema.type;
    if (Array.isArray(type)) return type.join(" | ");
    if (typeof type === "string") return type;
    return "unknown";
  }

  private renderExamples(
    toolName: string,
    commandName: string,
    command: CommandDefinition,
  ): string {
    const examples = command.examples ?? [];
    if (examples.length === 0) return "No examples declared.";

    return examples
      .map((example) => {
        const args = example.input === undefined ? "" : ` ${this.renderExampleArgs(example.input)}`;
        return [
          `$ rig run ${CommandIds.from(toolName, commandName)}${args}`,
          `# ${example.title}: ${example.text}`,
        ].join("\n");
      })
      .join("\n\n");
  }

  private renderExampleArgs(input: unknown): string {
    if (!this.isRecord(input)) return this.shellArg(String(input));
    const entries = Object.entries(input);
    if (entries.length === 1) return this.shellArg(String(entries[0]?.[1]));
    return entries.map(([key, value]) => `${key}=${this.shellArg(String(value))}`).join(" ");
  }

  private shellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class ToolHelpService {
  private readonly loader: ToolLoader;
  private readonly renderer: ToolHelpRenderer;

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
    this.renderer = new ToolHelpRenderer();
  }

  async render(toolName: string, commandName?: string): Promise<string> {
    const target = this.helpTarget(toolName, commandName);
    const tool = await this.loader.load(target.toolName);
    return this.renderer.render(tool.definition, target.commandName);
  }

  private helpTarget(
    toolName: string,
    commandName?: string,
  ): { toolName: string; commandName?: string } {
    if (commandName || !toolName.includes(".")) return { toolName, commandName };
    const [parsedToolName, parsedCommandName] = toolName.split(".", 2);
    return { toolName: parsedToolName!, commandName: parsedCommandName };
  }
}
