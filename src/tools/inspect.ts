import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { ToolLoader } from "./loader";
import { SchemaRenderer } from "./schema";
import { CommandIds, type CommandDefinition } from "./types";

export class ToolInspector {
  private readonly loader: ToolLoader;

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
  }

  async inspect(toolName: string, commandName?: string) {
    const target = this.inspectTarget(toolName, commandName);
    const loaded = await this.loader.load(target.toolName);
    const definition = loaded.definition;

    if (target.commandName) {
      const command = definition.commands[target.commandName];
      if (!command) {
        throw new RigError(
          "COMMAND_NOT_FOUND",
          `Command not found: ${CommandIds.from(target.toolName, target.commandName)}`,
          {
            tool: target.toolName,
            command: target.commandName,
            available: Object.keys(definition.commands),
          },
        );
      }
      return {
        tool: definition.name,
        command: target.commandName,
        path: loaded.path,
        ...this.commandMetadata(definition.name, target.commandName, command),
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

  private inspectTarget(
    toolName: string,
    commandName?: string,
  ): { toolName: string; commandName?: string } {
    if (commandName || !toolName.includes(".")) return { toolName, commandName };
    const [parsedToolName, parsedCommandName] = toolName.split(".", 2);
    return { toolName: parsedToolName!, commandName: parsedCommandName };
  }

  private commandMetadata(toolName: string, name: string, command: CommandDefinition) {
    return {
      name,
      id: CommandIds.from(toolName, name),
      description: command.description,
      inputSchema: SchemaRenderer.toJsonSchema(command.input),
      outputSchema: SchemaRenderer.toJsonSchema(command.output),
      run: `rig run ${CommandIds.from(toolName, name)} [args...]`,
      examples: command.examples ?? [],
    };
  }
}
