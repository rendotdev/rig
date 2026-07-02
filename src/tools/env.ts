import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigOptions } from "../config/config";
import { RigError } from "../errors/RigError";
import { SchemaRenderer } from "./schema";
import { ToolLoader } from "./loader";

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

class ToolEnvTarget {
  constructor(readonly tool: string) {}

  static parse(value: string): ToolEnvTarget {
    if (value && !value.includes(".")) return new ToolEnvTarget(value);
    throw new RigError("INPUT_ERROR", `Env target must use <tool>: ${value}`);
  }
}

class EnvKeyParser {
  parse(keys: string[]): string[] {
    if (keys.length === 0) {
      throw new RigError("INPUT_ERROR", "Env remove expects at least one KEY.");
    }
    return keys.map((key) => this.parseOne(key));
  }

  private parseOne(key: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RigError("INPUT_ERROR", `Env key must be a valid shell variable name: ${key}`);
    }
    return key;
  }
}

class EnvAssignmentParser {
  parse(assignments: string[]): Record<string, string> {
    return Object.fromEntries(assignments.map((assignment) => this.parseOne(assignment)));
  }

  private parseOne(assignment: string): [string, string] {
    const separator = assignment.indexOf("=");
    const key = assignment.slice(0, separator);
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new RigError("INPUT_ERROR", `Env assignment must use KEY=VALUE: ${assignment}`);
    }
    return [key, assignment.slice(separator + 1)];
  }
}

class DotEnvDocument {
  parse(source: string, path: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const parsed = this.parseLine(line, path, index + 1);
      if (parsed) values[parsed.key] = parsed.value;
    }
    return values;
  }

  serialize(values: Record<string, string>): string {
    const lines = Object.entries(values)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${this.renderValue(value)}`);
    return `${lines.join("\n")}\n`;
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
      throw new RigError("TOOL_INVALID", "Invalid .env line.", { path, line: lineNumber });
    }

    return { key: match[1]!, value: this.parseValue(match[2]!) };
  }

  private parseValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;
    if (trimmed[0] === '"' && trimmed.at(-1) === '"') return JSON.parse(trimmed) as string;
    if (trimmed[0] === "'" && trimmed.at(-1) === "'") return trimmed.slice(1, -1);
    return trimmed;
  }

  private renderValue(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+,-]*$/.test(value)) return value;
    return JSON.stringify(value);
  }
}

class EnvSchemaSummary {
  entries(schema: unknown, values: Record<string, string>): ToolEnvEntry[] {
    const jsonSchema = SchemaRenderer.toJsonSchema(schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) return [];

    /* v8 ignore next */
    const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
    return Object.keys(jsonSchema.properties)
      .toSorted()
      .map((key) => ({
        key,
        required: required.includes(key),
        set: values[key] !== undefined,
      }));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class ToolEnvService {
  private readonly loader: ToolLoader;
  private readonly assignments = new EnvAssignmentParser();
  private readonly keys = new EnvKeyParser();
  private readonly document = new DotEnvDocument();
  private readonly summary = new EnvSchemaSummary();

  constructor(options: ConfigOptions = {}) {
    this.loader = new ToolLoader(options);
  }

  async configure(targetValue: string, assignments: string[] = []): Promise<ToolEnvResult> {
    const target = ToolEnvTarget.parse(targetValue);
    const loaded = await this.loader.loadDefinition(target.tool);
    if (!loaded.definition.env) {
      throw new RigError("TOOL_INVALID", `Tool ${target.tool} does not define an env schema.`, {
        tool: target.tool,
      });
    }

    const envPath = join(dirname(loaded.path), ".env");
    const existing = await this.readEnv(envPath);
    if (assignments.length === 0) {
      return this.result(target, envPath, false, existing, loaded.definition.env, [], []);
    }

    if (assignments[0] === "remove") {
      const keys = this.keys.parse(assignments.slice(1));
      const nextValues = { ...existing };
      const removedKeys = keys.filter((key) => key in nextValues);
      for (const key of keys) delete nextValues[key];
      this.validateEnv(target, envPath, loaded.definition.env, nextValues);
      if (removedKeys.length > 0) await this.writeEnv(envPath, nextValues);
      return this.result(
        target,
        envPath,
        removedKeys.length > 0,
        nextValues,
        loaded.definition.env,
        [],
        removedKeys,
      );
    }

    const updates = this.assignments.parse(assignments);
    const nextValues = { ...existing, ...updates };
    this.validateEnv(target, envPath, loaded.definition.env, nextValues);

    await this.writeEnv(envPath, nextValues);
    return this.result(
      target,
      envPath,
      true,
      nextValues,
      loaded.definition.env,
      Object.keys(updates),
      [],
    );
  }

  private validateEnv(
    target: ToolEnvTarget,
    envPath: string,
    schema: { safeParse(value: unknown): { success: boolean; error?: { flatten(): unknown } } },
    values: Record<string, string>,
  ): void {
    const validation = schema.safeParse(values);
    if (validation.success) return;
    throw new RigError("TOOL_INVALID", `Tool ${target.tool} env would be invalid.`, {
      path: envPath,
      errors: validation.error?.flatten(),
    });
  }

  private result(
    target: ToolEnvTarget,
    envPath: string,
    updated: boolean,
    values: Record<string, string>,
    schema: unknown,
    updatedKeys: string[],
    removedKeys: string[],
  ): ToolEnvResult {
    return {
      tool: target.tool,
      envPath,
      updated,
      entries: this.summary.entries(schema, values),
      updatedKeys: updatedKeys.toSorted(),
      removedKeys: removedKeys.toSorted(),
    };
  }

  private async readEnv(path: string): Promise<Record<string, string>> {
    if (!existsSync(path)) return {};
    return this.document.parse(await readFile(path, "utf8"), path);
  }

  private async writeEnv(path: string, values: Record<string, string>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.document.serialize(values), "utf8");
  }
}
