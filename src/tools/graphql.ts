import { CommandIds, type CommandDefinition } from "./types";
import { SchemaRenderer } from "./schema";

export class GraphApiRenderer {
  static fieldName(toolName: string, commandName: string): string {
    return `${toolName}_${commandName}`.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  static operationKind(command: CommandDefinition): "Query" | "Mutation" {
    return command.sideEffects === "read" ? "Query" : "Mutation";
  }

  static renderCommandApi(
    toolName: string,
    commandName: string,
    command: CommandDefinition,
  ): string {
    const inputType = this.typeName(toolName, commandName, "Input");
    const payloadType = this.typeName(toolName, commandName, "Payload");
    const fieldName = this.fieldName(toolName, commandName);
    const operation = this.operationKind(command);
    const inputSchema = SchemaRenderer.toJsonSchema(command.input);
    const outputSchema = SchemaRenderer.toJsonSchema(command.output);
    const sideEffect = command.sideEffects.toUpperCase();

    return [
      `# Rig command id: ${CommandIds.from(toolName, commandName)}`,
      `type ${operation} {`,
      `  ${fieldName}(input: ${inputType}): ${payloadType}! @sideEffects(level: ${sideEffect})`,
      "}",
      "",
      `input ${inputType} {`,
      ...this.renderFields(inputSchema, "input"),
      "}",
      "",
      `type ${payloadType} {`,
      ...this.renderFields(outputSchema, "output"),
      "}",
    ].join("\n");
  }

  static metadata(toolName: string, commandName: string, command: CommandDefinition) {
    return {
      style: "graphql-inspired",
      operation: this.operationKind(command).toLowerCase(),
      field: this.fieldName(toolName, commandName),
      path: [toolName, commandName],
      id: CommandIds.from(toolName, commandName),
      sdl: this.renderCommandApi(toolName, commandName, command),
    };
  }

  private static typeName(toolName: string, commandName: string, suffix: string): string {
    return `${this.pascalCase(toolName)}${this.pascalCase(commandName)}${suffix}`;
  }

  private static pascalCase(value: string): string {
    return value
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join("");
  }

  private static renderFields(schema: unknown, mode: "input" | "output"): string[] {
    if (!this.isRecord(schema) || !this.isRecord(schema.properties)) return ["  value: JSON"];
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.entries(schema.properties).map(([name, property]) => {
      const hasDefault = this.isRecord(property) && property.default !== undefined;
      const requiredMark = required.includes(name) && !hasDefault ? "!" : "";
      const defaultText = hasDefault ? ` = ${this.literal(property.default)}` : "";
      const suffix = mode === "input" ? defaultText : "";
      return `  ${name}: ${this.graphScalar(property)}${requiredMark}${suffix}`;
    });
  }

  private static graphScalar(schema: unknown, fallback = "JSON"): string {
    if (!this.isRecord(schema)) return fallback;
    const type = schema.type;
    if (type === "string") return "String";
    if (type === "integer") return "Int";
    if (type === "number") return "Float";
    if (type === "boolean") return "Boolean";
    if (type === "array") return `[${this.graphScalar(schema.items, "JSON")}]`;
    if (Array.isArray(type)) {
      const firstNonNull = type.find((entry) => entry !== "null");
      return this.graphScalar({ ...schema, type: firstNonNull }, fallback);
    }
    return fallback;
  }

  private static literal(value: unknown): string {
    return JSON.stringify(value);
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
