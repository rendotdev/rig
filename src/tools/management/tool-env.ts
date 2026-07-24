import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineService, defineSingleton } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolLoaderClass } from "../loader";
import { schemaRenderer } from "../schema";

export type ToolEnvEntry = {
  key: string;
  required: boolean;
  set: boolean;
};

export type ToolEnvResult = {
  tool: string;
  envPath: string;
  updated: boolean;
  entries: ToolEnvEntry[];
  updatedKeys: string[];
  removedKeys: string[];
};

type ToolEnvTarget = { tool: string };

function parseTarget(params: { value: string }): ToolEnvTarget {
  if (params.value && !params.value.includes(".")) return { tool: params.value };
  throw new RigErrorClass("INPUT_ERROR", `Env target must use <tool>: ${params.value}`);
}

function parseKey(params: { key: string }): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.key)) {
    throw new RigErrorClass(
      "INPUT_ERROR",
      `Env key must be a valid shell variable name: ${params.key}`,
    );
  }
  return params.key;
}

function parseKeys(params: { keys: string[] }): string[] {
  if (params.keys.length === 0) {
    throw new RigErrorClass("INPUT_ERROR", "Env remove expects at least one KEY.");
  }
  return params.keys.map(function parseEnvKey(key) {
    return parseKey({ key });
  });
}

function parseAssignment(params: { assignment: string }): [string, string] {
  const separator = params.assignment.indexOf("=");
  const key = params.assignment.slice(0, separator);
  if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new RigErrorClass(
      "INPUT_ERROR",
      `Env assignment must use KEY=VALUE: ${params.assignment}`,
    );
  }
  return [key, params.assignment.slice(separator + 1)];
}

function parseAssignments(params: { assignments: string[] }): Record<string, string> {
  return Object.fromEntries(
    params.assignments.map(function parseEnvAssignment(assignment) {
      return parseAssignment({ assignment });
    }),
  );
}

function parseValue(params: { value: string }): string {
  const trimmed = params.value.trim();
  if (trimmed.length < 2) return trimmed;
  if (trimmed[0] === '"' && trimmed.at(-1) === '"') return JSON.parse(trimmed) as string;
  if (trimmed[0] === "'" && trimmed.at(-1) === "'") return trimmed.slice(1, -1);
  return trimmed;
}

function parseLine(params: {
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
  return { key: match[1]!, value: parseValue({ value: match[2]! }) };
}

function parseDocument(params: { source: string; path: string }): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, line] of params.source.split(/\r?\n/).entries()) {
    const parsed = parseLine({ line, path: params.path, lineNumber: index + 1 });
    if (parsed) values[parsed.key] = parsed.value;
  }
  return values;
}

function renderValue(params: { value: string }): string {
  if (/^[A-Za-z0-9_./:=@%+,-]*$/.test(params.value)) return params.value;
  return JSON.stringify(params.value);
}

function serializeDocument(params: { values: Record<string, string> }): string {
  const lines = Object.entries(params.values)
    .toSorted(function compareKeys([left], [right]) {
      return left.localeCompare(right);
    })
    .map(function renderEntry([key, value]) {
      return `${key}=${renderValue({ value })}`;
    });
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaEntries(params: {
  schema: unknown;
  values: Record<string, string>;
}): ToolEnvEntry[] {
  const jsonSchema = schemaRenderer.toJsonSchema(params.schema);
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema.properties)) return [];

  /* v8 ignore next */
  const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  return Object.keys(jsonSchema.properties)
    .toSorted()
    .map(function createEntry(key) {
      return {
        key,
        required: required.includes(key),
        set: params.values[key] !== undefined,
      };
    });
}

export const ToolEnvSingleton = defineSingleton({
  params: {},
  deps: {},
  parseTarget,
  parseKeys,
  parseAssignments,
  parseDocument,
  serializeDocument,
  schemaEntries,
});

type ToolEnvSchema = {
  safeParse(value: unknown): { success: boolean; error?: { flatten(): unknown } };
};

function validateEnv(params: {
  target: ToolEnvTarget;
  envPath: string;
  schema: ToolEnvSchema;
  values: Record<string, string>;
}): void {
  const validation = params.schema.safeParse(params.values);
  if (validation.success) return;
  throw new RigErrorClass("TOOL_INVALID", `Tool ${params.target.tool} env would be invalid.`, {
    path: params.envPath,
    errors: validation.error?.flatten(),
  });
}

type ToolEnvServiceDeps = {
  loadDefinition: ToolLoaderClass["loadDefinition"];
  exists: typeof existsSync;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  dirname: typeof dirname;
  join: typeof join;
};

function createToolEnvServiceDeps(options: ConfigOptions): ToolEnvServiceDeps {
  const loader = new ToolLoaderClass(options);
  return {
    loadDefinition: loader.loadDefinition.bind(loader),
    exists: existsSync,
    mkdir,
    readFile,
    writeFile,
    dirname,
    join,
  };
}

const ToolEnvServiceProductionDeps = createToolEnvServiceDeps({});

export class ToolEnvService extends defineService({
  params: {},
  deps: ToolEnvServiceProductionDeps,
}) {
  private async readEnv(params: { path: string }): Promise<Record<string, string>> {
    if (!this.deps.exists(params.path)) return {};
    return ToolEnvSingleton.parseDocument({
      source: await this.deps.readFile(params.path, "utf8"),
      path: params.path,
    });
  }

  private async writeEnv(params: { path: string; values: Record<string, string> }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(params.path), { recursive: true });
    await this.deps.writeFile(
      params.path,
      ToolEnvSingleton.serializeDocument({ values: params.values }),
      "utf8",
    );
  }

  private result(params: {
    target: ToolEnvTarget;
    envPath: string;
    updated: boolean;
    values: Record<string, string>;
    schema: unknown;
    updatedKeys: string[];
    removedKeys: string[];
  }): ToolEnvResult {
    return {
      tool: params.target.tool,
      envPath: params.envPath,
      updated: params.updated,
      entries: ToolEnvSingleton.schemaEntries({
        schema: params.schema,
        values: params.values,
      }),
      updatedKeys: params.updatedKeys.toSorted(),
      removedKeys: params.removedKeys.toSorted(),
    };
  }

  public async configure(params: {
    targetValue: string;
    assignments: string[];
  }): Promise<ToolEnvResult> {
    const assignments = params.assignments;
    const target = ToolEnvSingleton.parseTarget({ value: params.targetValue });
    const loaded = await this.deps.loadDefinition(target.tool);
    if (!loaded.definition.env) {
      throw new RigErrorClass(
        "TOOL_INVALID",
        `Tool ${target.tool} does not define an env schema.`,
        { tool: target.tool },
      );
    }

    const envPath = this.deps.join(this.deps.dirname(loaded.path), ".env");
    const existing = await this.readEnv({ path: envPath });
    if (assignments.length === 0) {
      return this.result({
        target,
        envPath,
        updated: false,
        values: existing,
        schema: loaded.definition.env,
        updatedKeys: [],
        removedKeys: [],
      });
    }

    if (assignments[0] === "remove") {
      const keys = ToolEnvSingleton.parseKeys({ keys: assignments.slice(1) });
      const nextValues = { ...existing };
      const removedKeys = keys.filter(function existingKey(key) {
        return key in nextValues;
      });
      for (const key of keys) delete nextValues[key];
      validateEnv({ target, envPath, schema: loaded.definition.env, values: nextValues });
      if (removedKeys.length > 0) await this.writeEnv({ path: envPath, values: nextValues });
      return this.result({
        target,
        envPath,
        updated: removedKeys.length > 0,
        values: nextValues,
        schema: loaded.definition.env,
        updatedKeys: [],
        removedKeys,
      });
    }

    const updates = ToolEnvSingleton.parseAssignments({ assignments });
    const nextValues = { ...existing, ...updates };
    validateEnv({ target, envPath, schema: loaded.definition.env, values: nextValues });
    await this.writeEnv({ path: envPath, values: nextValues });
    return this.result({
      target,
      envPath,
      updated: true,
      values: nextValues,
      schema: loaded.definition.env,
      updatedKeys: Object.keys(updates),
      removedKeys: [],
    });
  }
}

export const ToolEnv = new ToolEnvService();

export type ToolEnvServiceClass = {
  configure(targetValue: string, assignments?: string[]): Promise<ToolEnvResult>;
};

type ToolEnvServiceConstructor = {
  new (options?: ConfigOptions): ToolEnvServiceClass;
  readonly prototype: ToolEnvServiceClass;
};

type ToolEnvServiceAdapter = ToolEnvServiceClass & { readonly resource: ToolEnvService };

const ToolEnvServiceClassAdapter = function constructToolEnvService(
  this: ToolEnvServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolEnvService({ params: {}, deps: createToolEnvServiceDeps(options) }),
  });
};
Object.defineProperty(ToolEnvServiceClassAdapter, "name", { value: "ToolEnvServiceClass" });
Object.defineProperty(ToolEnvServiceClassAdapter.prototype, "configure", {
  configurable: true,
  value: function configure(
    this: ToolEnvServiceAdapter,
    targetValue: string,
    assignments: string[] = [],
  ) {
    return this.resource.configure({ targetValue, assignments });
  },
  writable: true,
});

export const ToolEnvServiceClass =
  ToolEnvServiceClassAdapter as unknown as ToolEnvServiceConstructor;
