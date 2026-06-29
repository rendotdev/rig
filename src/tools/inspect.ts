import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { GraphApiRenderer } from "./graphql";
import { ToolLoader } from "./loader";
import { SchemaRenderer } from "./schema";
import { CommandIds, type CommandDefinition } from "./types";

export class ToolInspector {
  private readonly loader: ToolLoader;

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
  }

  async inspect(toolName: string, commandName?: string) {
    const loaded = await this.loader.load(toolName);
    const definition = loaded.definition;

    if (commandName) {
      const command = definition.commands[commandName];
      if (!command) {
        throw new RigError(
          "COMMAND_NOT_FOUND",
          `Command not found: ${CommandIds.from(toolName, commandName)}`,
          {
            tool: toolName,
            command: commandName,
            available: Object.keys(definition.commands),
          },
        );
      }
      return {
        tool: definition.name,
        command: commandName,
        path: loaded.path,
        ...this.commandMetadata(definition.name, commandName, command),
      };
    }

    return {
      name: definition.name,
      description: definition.description,
      path: loaded.path,
      commands: Object.entries(definition.commands).map(([name, command]) =>
        this.commandMetadata(definition.name, name, command),
      ),
    };
  }

  private commandMetadata(toolName: string, name: string, command: CommandDefinition) {
    return {
      name,
      id: CommandIds.from(toolName, name),
      description: command.description,
      sideEffects: command.sideEffects,
      inputSchema: SchemaRenderer.toJsonSchema(command.input),
      outputSchema: SchemaRenderer.toJsonSchema(command.output),
      api: GraphApiRenderer.metadata(toolName, name, command),
      examples: command.examples ?? [],
    };
  }
}
