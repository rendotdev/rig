import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { GraphApiRenderer } from "./graphql";
import { ToolLoader } from "./loader";
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
    const lines = [
      `${heading} ${id}`,
      "",
      command.description,
      "",
      `Side effects: ${command.sideEffects}`,
      "",
      "API:",
      "",
      "```graphql",
      GraphApiRenderer.renderCommandApi(toolName, commandName, command),
      "```",
      "",
      "Use `rig tool inspect` for full JSON Schema metadata.",
      "",
      "Examples:",
      "",
      this.renderExamples(toolName, commandName, command),
      "",
      "Run:",
      "",
      "```bash",
      `rig run ${toolName} ${commandName} --input '{}'`,
      "```",
    ];

    if (options.detailed) {
      lines.splice(3, 0, "", `Tool: ${toolName}`, `Command: ${commandName}`);
    }

    return lines.join("\n");
  }

  private renderExamples(
    toolName: string,
    commandName: string,
    command: CommandDefinition,
  ): string {
    const examples = command.examples ?? [];
    if (examples.length === 0) return "No examples declared.";

    return examples
      .map((example, index) => {
        const lines = [`${index + 1}. ${example.title}`, example.text];
        if (example.input !== undefined) lines.push(`Input: ${this.compactJson(example.input)}`);
        if (example.output !== undefined) lines.push(`Output: ${this.compactJson(example.output)}`);
        if (example.input !== undefined) {
          lines.push(
            `Run: rig run ${toolName} ${commandName} --input '${this.compactJson(example.input)}'`,
          );
        }
        return lines.join("\n");
      })
      .join("\n\n");
  }

  private compactJson(value: unknown): string {
    return JSON.stringify(value);
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
    const tool = await this.loader.load(toolName);
    return this.renderer.render(tool.definition, commandName);
  }
}
