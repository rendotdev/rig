import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolLoaderClass } from "../loader";
import { schemaRenderer } from "../schema";
import { commandIds, type CommandDefinition } from "../types";
import { commandTargets, ToolNameClass } from "../identifiers";

export class ToolInspectorClass {
  private readonly loader: ToolLoaderClass;

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoaderClass(options);
  }

  async inspect(toolName: string, commandName?: string) {
    const target = this.inspectTarget(toolName, commandName);
    const loaded = await this.loader.load(target.toolName);
    const definition = loaded.definition;

    if (target.commandName) {
      const command = definition.commands[target.commandName];
      if (!command) {
        throw new RigErrorClass(
          "COMMAND_NOT_FOUND",
          `Command not found: ${commandIds.from(target.toolName, target.commandName)}`,
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
    if (commandName) {
      const target = commandTargets.from(toolName, commandName);
      return { toolName: target.tool, commandName: target.command };
    }
    if (!toolName.includes(".")) return { toolName: new ToolNameClass(toolName).value };
    const target = commandTargets.parse(toolName);
    return { toolName: target.tool, commandName: target.command };
  }

  private commandMetadata(toolName: string, name: string, command: CommandDefinition) {
    return {
      name,
      id: commandIds.from(toolName, name),
      description: command.description,
      inputSchema: schemaRenderer.toJsonSchema(command.input),
      outputSchema: schemaRenderer.toJsonSchema(command.output),
      run: `rig run ${commandIds.from(toolName, name)} [args...]`,
      examples: command.examples ?? [],
    };
  }
}
