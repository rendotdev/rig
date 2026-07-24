import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineRuntime, defineService, defineSingleton } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolDiscoveryServiceClass, type DiscoveredTool } from "../../registry/discover";
import { collectionNames, commandNames, toolNames } from "../identifiers";
import { createRigToolKit } from "../sdk";
import { commandIds, type CommandDefinition, type LoadedTool, type ToolDefinition } from "../types";

export type LoadedToolDefinition = Omit<LoadedTool, "env">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSafeParse(params: { value: unknown }): boolean {
  return isRecord(params.value) && typeof params.value.safeParse === "function";
}

function validateSchema(params: { value: unknown; role: string; id: string }): void {
  if (!hasSafeParse({ value: params.value })) {
    throw new RigErrorClass(
      "TOOL_INVALID",
      `Command ${params.id} needs a Zod schema for ${params.role}.`,
      { expected: "rig.z.object({ ... })" },
    );
  }
}

function validateExamples(params: { value: unknown; path: string }): void {
  if (params.value === undefined) return;
  if (!Array.isArray(params.value)) {
    throw new RigErrorClass("TOOL_INVALID", `Invalid examples at ${params.path}.`, {
      expected: "array",
    });
  }

  for (const [index, example] of params.value.entries()) {
    if (!isRecord(example)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid example at ${params.path}[${index}].`, {
        expected: "object",
      });
    }
    if (typeof example.title !== "string" || example.title.length === 0) {
      throw new RigErrorClass(
        "TOOL_INVALID",
        `Invalid example title at ${params.path}[${index}].`,
        { expected: "non-empty string" },
      );
    }
    if (typeof example.text !== "string" || example.text.length === 0) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid example text at ${params.path}[${index}].`, {
        expected: "non-empty string",
      });
    }
  }
}

function validateToolName(params: { name: string }): void {
  toolNames.parse(params.name);
}

function validateCommandName(params: { name: string }): void {
  commandNames.parse(params.name);
}

function validateCommand(params: { commandName: string; value: unknown; toolName: string }): void {
  validateCommandName({ name: params.commandName });
  const id = commandIds.from(params.toolName, params.commandName);

  if (!isRecord(params.value)) {
    throw new RigErrorClass("TOOL_INVALID", `Invalid command ${id}.`, { expected: "object" });
  }
  if (typeof params.value.description !== "string" || params.value.description.length === 0) {
    throw new RigErrorClass("TOOL_INVALID", `Command ${id} needs a description.`, {
      expected: "non-empty string",
    });
  }
  validateSchema({ value: params.value.input, role: "input", id });
  validateSchema({ value: params.value.output, role: "output", id });
  validateExamples({ value: params.value.examples, path: `${id}.examples` });
  if (typeof params.value.run !== "function") {
    throw new RigErrorClass("TOOL_INVALID", `Command ${id} needs a run function.`, {
      expected: "function",
    });
  }
}

function validateToolDefinition(params: { value: unknown; expectedName?: string }): ToolDefinition {
  if (!isRecord(params.value)) {
    throw new RigErrorClass("TOOL_INVALID", "Tool default export must be an object.");
  }
  const name =
    typeof params.value.name === "string" && params.value.name.length > 0
      ? params.value.name
      : params.expectedName;
  if (!name) {
    throw new RigErrorClass("TOOL_INVALID", "Tool needs a name.", {
      expected: "non-empty string or a discovered tool folder",
    });
  }

  validateToolName({ name });
  if (params.expectedName && name !== params.expectedName) {
    throw new RigErrorClass(
      "TOOL_INVALID",
      `Tool name does not match its folder: ${name} should be ${params.expectedName}.`,
      { expectedName: params.expectedName, actualName: name },
    );
  }
  if (typeof params.value.description !== "string" || params.value.description.length === 0) {
    throw new RigErrorClass("TOOL_INVALID", `Tool ${name} needs a description.`, {
      expected: "non-empty string",
    });
  }
  if (params.value.setupDb !== undefined && typeof params.value.setupDb !== "function") {
    throw new RigErrorClass("TOOL_INVALID", `Tool ${name} setupDb must be a function.`, {
      expected: "function",
    });
  }
  if (params.value.env !== undefined)
    validateSchema({ value: params.value.env, role: "env", id: name });
  if (params.value.collections !== undefined) {
    if (!isRecord(params.value.collections)) {
      throw new RigErrorClass("TOOL_INVALID", `Tool ${name} needs a collections object.`, {
        expected: "object",
      });
    }
    for (const collectionName of Object.keys(params.value.collections)) {
      collectionNames.parse(collectionName);
    }
  }
  if (!isRecord(params.value.commands)) {
    throw new RigErrorClass("TOOL_INVALID", `Tool ${name} needs a commands object.`, {
      expected: "object",
    });
  }
  const entries = Object.entries(params.value.commands);
  if (entries.length === 0) {
    throw new RigErrorClass("TOOL_INVALID", `Tool ${name} must define at least one command.`);
  }
  for (const [commandName, command] of entries) {
    validateCommand({ commandName, value: command, toolName: name });
  }

  return (params.value.name === name ? params.value : { ...params.value, name }) as ToolDefinition;
}

export const ToolDefinitionValidatorSingleton = defineSingleton({
  params: {},
  deps: {},
  validateToolName,
  validateCommandName,
  validateToolDefinition,
});

export type ToolDefinitionValidatorClass = {
  validateToolName(name: string): void;
  validateCommandName(name: string): void;
  validateToolDefinition(value: unknown, expectedName?: string): ToolDefinition;
};

type ToolDefinitionValidatorConstructor = {
  new (): ToolDefinitionValidatorClass;
  readonly prototype: ToolDefinitionValidatorClass;
};

const ToolDefinitionValidatorClassAdapter = function constructToolDefinitionValidator(): void {};
Object.defineProperty(ToolDefinitionValidatorClassAdapter, "name", {
  value: "ToolDefinitionValidatorClass",
});
Object.defineProperties(ToolDefinitionValidatorClassAdapter.prototype, {
  validateToolName: {
    configurable: true,
    value: function validateLegacyToolName(_name: string) {
      return ToolDefinitionValidatorSingleton.validateToolName({ name: _name });
    },
    writable: true,
  },
  validateCommandName: {
    configurable: true,
    value: function validateLegacyCommandName(name: string) {
      return ToolDefinitionValidatorSingleton.validateCommandName({ name });
    },
    writable: true,
  },
  validateToolDefinition: {
    configurable: true,
    value: function validateLegacyToolDefinition(value: unknown, expectedName?: string) {
      return ToolDefinitionValidatorSingleton.validateToolDefinition({ value, expectedName });
    },
    writable: true,
  },
});

export const ToolDefinitionValidatorClass =
  ToolDefinitionValidatorClassAdapter as unknown as ToolDefinitionValidatorConstructor;

function parseEnvValue(params: { value: string }): string {
  const trimmed = params.value.trim();
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

function parseEnvLine(params: {
  line: string;
  path: string;
  lineNumber: number;
}): { key: string; value: string } | undefined {
  const trimmed = params.line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) {
    throw new RigErrorClass("TOOL_INVALID", "Invalid .env line.", {
      path: params.path,
      line: params.lineNumber,
    });
  }
  return { key: match[1]!, value: parseEnvValue({ value: match[2]! }) };
}

function parseEnvFile(params: { source: string; path: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [index, line] of params.source.split(/\r?\n/).entries()) {
    const parsed = parseEnvLine({ line, path: params.path, lineNumber: index + 1 });
    if (parsed) env[parsed.key] = parsed.value;
  }
  return env;
}

export const ToolEnvFileParserSingleton = defineSingleton({
  params: {},
  deps: {},
  parse: parseEnvFile,
});

type ToolEnvLoaderDeps = {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  dirname: typeof dirname;
  join: typeof join;
};

function bunFile():
  | ((path: string) => { exists(): Promise<boolean>; text(): Promise<string> })
  | undefined {
  const candidate = (globalThis as typeof globalThis & { Bun?: { file?: unknown } }).Bun?.file;
  /* v8 ignore next */
  return typeof candidate === "function" ? (candidate as never) : undefined;
}

const ToolEnvLoaderProductionDeps: ToolEnvLoaderDeps = {
  async exists(path) {
    const bun = bunFile();
    /* v8 ignore next 3 */
    if (bun) return await bun(path).exists();
    return existsSync(path);
  },
  async readText(path) {
    const bun = bunFile();
    /* v8 ignore next */
    if (bun) return await bun(path).text();
    return await readFile(path, "utf8");
  },
  dirname,
  join,
};

export class ToolEnvLoaderService extends defineService({
  params: {},
  deps: ToolEnvLoaderProductionDeps,
}) {
  public async load(params: {
    tool: DiscoveredTool;
    definition: ToolDefinition;
  }): Promise<unknown> {
    const envPath = this.deps.join(this.deps.dirname(params.tool.toolPath), ".env");
    const fileExists = await this.deps.exists(envPath);
    if (!params.definition.env) {
      if (fileExists) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Tool ${params.definition.name} has .env but no env schema.`,
          { path: envPath },
        );
      }
      return {};
    }
    const rawEnv = fileExists
      ? ToolEnvFileParserSingleton.parse({
          source: await this.deps.readText(envPath),
          path: envPath,
        })
      : {};
    const result = params.definition.env.safeParse(rawEnv);
    if (!result.success) {
      throw new RigErrorClass("TOOL_INVALID", `Tool ${params.definition.name} env is invalid.`, {
        path: envPath,
        errors: result.error.flatten(),
      });
    }
    return result.data;
  }
}

export const ToolEnvLoader = new ToolEnvLoaderService();

type ToolLoaderDeps = {
  findTool: ToolDiscoveryServiceClass["find"];
  stat: typeof stat;
  pathToFileUrl: typeof pathToFileURL;
  importModule: (url: string) => Promise<unknown>;
  createToolKit: typeof createRigToolKit;
  loadEnv: ToolEnvLoaderService["load"];
};

function createToolLoaderDeps(options: ConfigOptions): ToolLoaderDeps {
  const discovery = new ToolDiscoveryServiceClass(options);
  const envLoader = new ToolEnvLoaderService({ params: {}, deps: ToolEnvLoaderProductionDeps });
  return {
    findTool: discovery.find.bind(discovery),
    stat,
    pathToFileUrl: pathToFileURL,
    importModule(url) {
      return import(url) as Promise<unknown>;
    },
    createToolKit: createRigToolKit,
    loadEnv(params) {
      return envLoader.load(params);
    },
  };
}

const ToolLoaderProductionDeps = createToolLoaderDeps({});

export class ToolLoaderService extends defineRuntime({
  params: {},
  deps: ToolLoaderProductionDeps,
}) {
  private readonly discoveredTools = new Map<string, DiscoveredTool>();
  private readonly definitions = new Map<
    string,
    { modifiedAtMs: number; size: number; value: LoadedToolDefinition }
  >();

  private async find(params: { name: string }): Promise<DiscoveredTool> {
    const cached = this.discoveredTools.get(params.name);
    if (cached) return cached;
    const discovered = await this.deps.findTool(params.name);
    this.discoveredTools.set(params.name, discovered);
    return discovered;
  }

  private async evaluateModuleDefault(params: {
    value: unknown;
    toolName: string;
  }): Promise<unknown> {
    const awaitedValue = await Promise.resolve(params.value);
    if (typeof awaitedValue !== "function") return awaitedValue;
    try {
      return await awaitedValue(this.deps.createToolKit());
    } catch (error) {
      throw new RigErrorClass(
        "TOOL_INVALID",
        `Could not evaluate tool factory ${params.toolName}.`,
        { tool: params.toolName, error },
      );
    }
  }

  public async loadDefinitionDiscovered(params: {
    tool: DiscoveredTool;
  }): Promise<LoadedToolDefinition> {
    const metadata = await this.deps.stat(params.tool.toolPath);
    const cached = this.definitions.get(params.tool.toolPath);
    if (cached?.modifiedAtMs === metadata.mtimeMs && cached.size === metadata.size) {
      return cached.value;
    }

    const url = `${this.deps.pathToFileUrl(params.tool.toolPath).href}?rig=${metadata.mtimeMs}-${metadata.size}`;
    let moduleValue: unknown;
    try {
      moduleValue = await this.deps.importModule(url);
    } catch (error) {
      throw new RigErrorClass("TOOL_INVALID", `Could not load tool ${params.tool.name}.`, {
        path: params.tool.toolPath,
        error,
      });
    }

    const moduleRecord = moduleValue as { default?: unknown };
    const definitionValue = await this.evaluateModuleDefault({
      value: moduleRecord.default,
      toolName: params.tool.name,
    });
    const definition = ToolDefinitionValidatorSingleton.validateToolDefinition({
      value: definitionValue,
      expectedName: params.tool.name,
    });
    const loaded = { name: definition.name, path: params.tool.toolPath, definition };
    this.definitions.set(params.tool.toolPath, {
      modifiedAtMs: metadata.mtimeMs,
      size: metadata.size,
      value: loaded,
    });
    return loaded;
  }

  public async loadDefinition(params: { name: string }): Promise<LoadedToolDefinition> {
    return await this.loadDefinitionDiscovered({ tool: await this.find(params) });
  }

  public async loadDiscovered(params: { tool: DiscoveredTool }): Promise<LoadedTool> {
    const loaded = await this.loadDefinitionDiscovered(params);
    const env = await this.deps.loadEnv({ tool: params.tool, definition: loaded.definition });
    return { ...loaded, env };
  }

  public async load(params: { name: string }): Promise<LoadedTool> {
    ToolDefinitionValidatorSingleton.validateToolName(params);
    return await this.loadDiscovered({ tool: await this.find(params) });
  }

  public async loadCommand(params: { toolName: string; commandName: string }) {
    const tool = await this.load({ name: params.toolName });
    ToolDefinitionValidatorSingleton.validateCommandName({ name: params.commandName });
    const command = tool.definition.commands[params.commandName];
    if (!command) {
      throw new RigErrorClass(
        "COMMAND_NOT_FOUND",
        `Command not found: ${commandIds.from(params.toolName, params.commandName)}`,
        {
          tool: params.toolName,
          command: params.commandName,
          available: Object.keys(tool.definition.commands),
        },
      );
    }
    return { tool, commandName: params.commandName, command };
  }

  public validateToolName(params: { name: string }): void {
    validateToolName(params);
  }

  public validateCommandName(params: { name: string }): void {
    validateCommandName(params);
  }
}

export const ToolLoader = new ToolLoaderService();

export type ToolLoaderClass = {
  validateToolName(name: string): void;
  validateCommandName(name: string): void;
  loadDefinition(name: string): Promise<LoadedToolDefinition>;
  loadDefinitionDiscovered(tool: DiscoveredTool): Promise<LoadedToolDefinition>;
  loadDiscovered(tool: DiscoveredTool): Promise<LoadedTool>;
  load(name: string): Promise<LoadedTool>;
  loadCommand(
    toolName: string,
    commandName: string,
  ): Promise<{
    tool: LoadedTool;
    commandName: string;
    command: CommandDefinition;
  }>;
};

type ToolLoaderConstructor = {
  new (options?: ConfigOptions): ToolLoaderClass;
  readonly prototype: ToolLoaderClass;
};

type ToolLoaderAdapter = ToolLoaderClass & { readonly resource: ToolLoaderService };

const ToolLoaderClassAdapter = function constructToolLoader(
  this: ToolLoaderAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolLoaderService({ params: {}, deps: createToolLoaderDeps(options) }),
  });
};
Object.defineProperty(ToolLoaderClassAdapter, "name", { value: "ToolLoaderClass" });
Object.defineProperties(ToolLoaderClassAdapter.prototype, {
  validateToolName: {
    configurable: true,
    value: function validateLegacyToolName(this: ToolLoaderAdapter, name: string) {
      return this.resource.validateToolName({ name });
    },
    writable: true,
  },
  validateCommandName: {
    configurable: true,
    value: function validateLegacyCommandName(this: ToolLoaderAdapter, name: string) {
      return this.resource.validateCommandName({ name });
    },
    writable: true,
  },
  loadDefinition: {
    configurable: true,
    value: function loadDefinition(this: ToolLoaderAdapter, name: string) {
      return this.resource.loadDefinition({ name });
    },
    writable: true,
  },
  loadDefinitionDiscovered: {
    configurable: true,
    value: function loadDefinitionDiscovered(this: ToolLoaderAdapter, tool: DiscoveredTool) {
      return this.resource.loadDefinitionDiscovered({ tool });
    },
    writable: true,
  },
  loadDiscovered: {
    configurable: true,
    value: function loadDiscovered(this: ToolLoaderAdapter, tool: DiscoveredTool) {
      return this.resource.loadDiscovered({ tool });
    },
    writable: true,
  },
  load: {
    configurable: true,
    value: function load(this: ToolLoaderAdapter, name: string) {
      return this.resource.load({ name });
    },
    writable: true,
  },
  loadCommand: {
    configurable: true,
    value: function loadCommand(this: ToolLoaderAdapter, toolName: string, commandName: string) {
      return this.resource.loadCommand({ toolName, commandName });
    },
    writable: true,
  },
});

export const ToolLoaderClass = ToolLoaderClassAdapter as unknown as ToolLoaderConstructor;
