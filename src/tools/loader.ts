import { pathToFileURL } from "node:url";
import { ToolDiscoveryService, type DiscoveredTool } from "../registry/discover";
import { RigError } from "../errors/RigError";
import type { ConfigOptions } from "../config/config";
import { createRigToolKit } from "./sdk";
import { CommandIds, type CommandDefinition, type LoadedTool, type ToolDefinition } from "./types";

export class ToolDefinitionValidator {
  validateToolName(name: string): void {
    if (!name || typeof name !== "string") {
      throw new RigError("TOOL_INVALID", `Invalid tool name: ${name}`, {
        expected: "non-empty string",
      });
    }
  }

  validateCommandName(name: string): void {
    if (!name || typeof name !== "string") {
      throw new RigError("TOOL_INVALID", `Invalid command name: ${name}`, {
        expected: "non-empty string",
      });
    }
  }

  validateToolDefinition(value: unknown, expectedName?: string): ToolDefinition {
    if (!this.isRecord(value)) {
      throw new RigError("TOOL_INVALID", "Tool default export must be an object.");
    }
    if (typeof value.name !== "string" || value.name.length === 0) {
      throw new RigError("TOOL_INVALID", "Tool needs a name.", { expected: "non-empty string" });
    }

    this.validateToolName(value.name);

    if (expectedName && value.name !== expectedName) {
      throw new RigError(
        "TOOL_INVALID",
        `Tool name does not match its folder: ${value.name} should be ${expectedName}.`,
        {
          expectedName,
          actualName: value.name,
        },
      );
    }

    if (typeof value.description !== "string" || value.description.length === 0) {
      throw new RigError("TOOL_INVALID", `Tool ${value.name} needs a description.`, {
        expected: "non-empty string",
      });
    }

    if (!this.isRecord(value.commands)) {
      throw new RigError("TOOL_INVALID", `Tool ${value.name} needs a commands object.`, {
        expected: "object",
      });
    }

    const entries = Object.entries(value.commands);
    if (entries.length === 0) {
      throw new RigError("TOOL_INVALID", `Tool ${value.name} must define at least one command.`);
    }

    for (const [commandName, command] of entries) {
      this.validateCommand(commandName, command, value.name);
    }

    return value as ToolDefinition;
  }

  private validateCommand(
    commandName: string,
    value: unknown,
    toolName: string,
  ): asserts value is CommandDefinition {
    this.validateCommandName(commandName);
    const id = CommandIds.from(toolName, commandName);

    if (!this.isRecord(value)) {
      throw new RigError("TOOL_INVALID", `Invalid command ${id}.`, { expected: "object" });
    }

    if (typeof value.description !== "string" || value.description.length === 0) {
      throw new RigError("TOOL_INVALID", `Command ${id} needs a description.`, {
        expected: "non-empty string",
      });
    }

    this.validateSchema(value.input, "input", id);
    this.validateSchema(value.output, "output", id);

    this.validateExamples(value.examples, `${id}.examples`);

    if (typeof value.run !== "function") {
      throw new RigError("TOOL_INVALID", `Command ${id} needs a run function.`, {
        expected: "function",
      });
    }
  }

  private validateExamples(value: unknown, path: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new RigError("TOOL_INVALID", `Invalid examples at ${path}.`, { expected: "array" });
    }

    for (const [index, example] of value.entries()) {
      if (!this.isRecord(example)) {
        throw new RigError("TOOL_INVALID", `Invalid example at ${path}[${index}].`, {
          expected: "object",
        });
      }
      if (typeof example.title !== "string" || example.title.length === 0) {
        throw new RigError("TOOL_INVALID", `Invalid example title at ${path}[${index}].`, {
          expected: "non-empty string",
        });
      }
      if (typeof example.text !== "string" || example.text.length === 0) {
        throw new RigError("TOOL_INVALID", `Invalid example text at ${path}[${index}].`, {
          expected: "non-empty string",
        });
      }
    }
  }

  private validateSchema(value: unknown, role: string, id: string): void {
    if (!this.hasSafeParse(value)) {
      throw new RigError("TOOL_INVALID", `Command ${id} needs a Zod schema for ${role}.`, {
        expected: `rig.z.object({ ... })`,
      });
    }
  }

  private hasSafeParse(value: unknown): boolean {
    return this.isRecord(value) && typeof value.safeParse === "function";
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class ToolLoader {
  private readonly discovery: ToolDiscoveryService;
  private readonly validator: ToolDefinitionValidator;

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryService(options);
    this.validator = new ToolDefinitionValidator();
  }

  validateToolName(name: string): void {
    this.validator.validateToolName(name);
  }

  validateCommandName(name: string): void {
    this.validator.validateCommandName(name);
  }

  async loadDiscovered(tool: DiscoveredTool): Promise<LoadedTool> {
    const url = `${pathToFileURL(tool.toolPath).href}?rig=${Date.now()}`;
    let moduleValue: unknown;
    try {
      moduleValue = await import(url);
    } catch (error) {
      throw new RigError("TOOL_INVALID", `Could not load tool ${tool.name}.`, {
        path: tool.toolPath,
        error,
      });
    }

    const moduleRecord = moduleValue as { default?: unknown };
    const definitionValue = await this.evaluateModuleDefault(moduleRecord.default, tool.name);
    const definition = this.validator.validateToolDefinition(definitionValue, tool.name);
    return { name: definition.name, path: tool.toolPath, definition };
  }

  private async evaluateModuleDefault(value: unknown, toolName: string): Promise<unknown> {
    const awaitedValue = await Promise.resolve(value);
    if (typeof awaitedValue !== "function") return awaitedValue;

    try {
      return await awaitedValue(createRigToolKit());
    } catch (error) {
      throw new RigError("TOOL_INVALID", `Could not evaluate tool factory ${toolName}.`, {
        tool: toolName,
        error,
      });
    }
  }

  async load(name: string): Promise<LoadedTool> {
    this.validator.validateToolName(name);
    return this.loadDiscovered(await this.discovery.find(name));
  }

  async loadCommand(toolName: string, commandName: string) {
    const tool = await this.load(toolName);
    this.validator.validateCommandName(commandName);
    const command = tool.definition.commands[commandName];
    if (!command) {
      throw new RigError(
        "COMMAND_NOT_FOUND",
        `Command not found: ${CommandIds.from(toolName, commandName)}`,
        {
          tool: toolName,
          command: commandName,
          available: Object.keys(tool.definition.commands),
        },
      );
    }
    return { tool, commandName, command };
  }
}
