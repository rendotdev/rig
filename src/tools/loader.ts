import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolDiscoveryService, type DiscoveredTool } from "../registry/discover";
import { RigError } from "../errors/RigError";
import type { ConfigOptions } from "../config/config";
import { createRigToolKit } from "./sdk";
import { CommandIds, type CommandDefinition, type LoadedTool, type ToolDefinition } from "./types";

export type LoadedToolDefinition = Omit<LoadedTool, "env">;

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

    if (value.setupDb !== undefined && typeof value.setupDb !== "function") {
      throw new RigError("TOOL_INVALID", `Tool ${value.name} setupDb must be a function.`, {
        expected: "function",
      });
    }

    if (value.env !== undefined) {
      this.validateSchema(value.env, "env", value.name);
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

class ToolEnvFileParser {
  parse(source: string, path: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const parsed = this.parseLine(line, path, index + 1);
      if (parsed) env[parsed.key] = parsed.value;
    }
    return env;
  }

  private parseLine(
    line: string,
    path: string,
    lineNumber: number,
  ): { key: string; value: string } | undefined {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return undefined;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new RigError("TOOL_INVALID", "Invalid .env line.", {
        path,
        line: lineNumber,
      });
    }

    return { key: match[1]!, value: this.parseValue(match[2]!) };
  }

  private parseValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;

    const quote = trimmed[0];
    if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed;

    const inner = trimmed.slice(1, -1);
    if (quote === "'") return inner;
    return inner
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
}

class ToolEnvLoader {
  private readonly parser = new ToolEnvFileParser();

  async load(tool: DiscoveredTool, definition: ToolDefinition): Promise<unknown> {
    const envPath = join(dirname(tool.toolPath), ".env");
    const fileExists = await this.exists(envPath);

    if (!definition.env) {
      if (fileExists) {
        throw new RigError("TOOL_INVALID", `Tool ${definition.name} has .env but no env schema.`, {
          path: envPath,
        });
      }
      return {};
    }

    const rawEnv = fileExists ? this.parser.parse(await this.readText(envPath), envPath) : {};
    const result = definition.env.safeParse(rawEnv);
    if (!result.success) {
      throw new RigError("TOOL_INVALID", `Tool ${definition.name} env is invalid.`, {
        path: envPath,
        errors: result.error.flatten(),
      });
    }
    return result.data;
  }

  private async exists(path: string): Promise<boolean> {
    const bunFile = this.bunFile();
    /* v8 ignore next 3 */
    if (bunFile) {
      return bunFile(path).exists();
    }
    return existsSync(path);
  }

  private async readText(path: string): Promise<string> {
    const bunFile = this.bunFile();
    /* v8 ignore next */
    if (bunFile) return bunFile(path).text();
    return readFile(path, "utf8");
  }

  private bunFile():
    | ((path: string) => { exists(): Promise<boolean>; text(): Promise<string> })
    | undefined {
    const candidate = (globalThis as typeof globalThis & { Bun?: { file?: unknown } }).Bun?.file;
    /* v8 ignore next */
    return typeof candidate === "function" ? (candidate as never) : undefined;
  }
}

export class ToolLoader {
  private readonly discovery: ToolDiscoveryService;
  private readonly validator: ToolDefinitionValidator;
  private readonly envLoader = new ToolEnvLoader();

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

  async loadDefinition(name: string): Promise<LoadedToolDefinition> {
    return this.loadDefinitionDiscovered(await this.discovery.find(name));
  }

  async loadDefinitionDiscovered(tool: DiscoveredTool): Promise<LoadedToolDefinition> {
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

  async loadDiscovered(tool: DiscoveredTool): Promise<LoadedTool> {
    const loaded = await this.loadDefinitionDiscovered(tool);
    const env = await this.envLoader.load(tool, loaded.definition);
    return { ...loaded, env };
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
