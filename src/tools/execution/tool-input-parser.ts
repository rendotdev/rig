import { RigErrorClass } from "../../errors/RigError";
import { schemaRenderer } from "../schema";

export class PipelineReferenceResolverClass {
  constructor(private readonly context: Record<string, unknown>) {}

  interpolateStringArray(values: string[]): string[] {
    return values.map((value) => String(this.interpolateString(value)));
  }

  interpolate(value: unknown): unknown {
    if (typeof value === "string") return this.interpolateString(value);
    if (Array.isArray(value)) return value.map((item) => this.interpolate(item));
    if (this.isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.interpolate(item)]),
      );
    }
    return value;
  }

  private interpolateString(value: string): unknown {
    const exact = value.match(/^@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?$/);
    if (exact) return this.lookup(exact[1], exact[2]);
    return value.replace(/@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?/g, (_match, id, path) =>
      String(this.lookup(id, path)),
    );
  }

  private lookup(id: string, path?: string): unknown {
    if (!(id in this.context)) {
      throw new RigErrorClass("INPUT_ERROR", `Pipeline reference is unknown: @${id}`, {
        reference: `@${id}`,
        available: Object.keys(this.context),
      });
    }

    let value = this.context[id];
    for (const part of path?.split(".").filter(Boolean) ?? []) {
      if (!this.isRecord(value) && !Array.isArray(value)) {
        throw new RigErrorClass("INPUT_ERROR", `Pipeline reference cannot access: @${id}.${path}`, {
          reference: `@${id}.${path}`,
          missing: part,
        });
      }
      value = (value as Record<string, unknown>)[part];
      if (value === undefined) {
        throw new RigErrorClass("INPUT_ERROR", `Pipeline reference is missing: @${id}.${path}`, {
          reference: `@${id}.${path}`,
          missing: part,
        });
      }
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}

export class InputArgumentParserClass {
  constructor(private readonly schema: unknown) {}

  parse(args: string[]): unknown {
    if (args.length === 1) {
      const maybeJson = this.tryParseJson(args[0]);
      if (maybeJson.parsed && this.shouldUseJsonValue(maybeJson.value)) return maybeJson.value;
    }

    if (args.every((arg) => arg.includes("="))) {
      return Object.fromEntries(args.map((arg) => this.parseKeyValueArg(arg)));
    }

    const fields = this.inputFieldNames();
    if (fields.length === 0) {
      if (args.length === 1) return this.parseScalar(args[0]);
      throw new RigErrorClass(
        "INPUT_ERROR",
        "This command does not declare positional input fields.",
        { args },
      );
    }

    if (args.length > fields.length) {
      throw new RigErrorClass("INPUT_ERROR", "Too many positional arguments.", {
        args,
        expectedFields: fields,
      });
    }

    return Object.fromEntries(args.map((arg, index) => [fields[index], this.parseScalar(arg)]));
  }

  private parseKeyValueArg(arg: string): [string, unknown] {
    const separatorIndex = arg.indexOf("=");
    const key = arg.slice(0, separatorIndex);
    const value = arg.slice(separatorIndex + 1);
    if (!key) {
      throw new RigErrorClass("INPUT_ERROR", "Argument keys must not be empty.", { arg });
    }
    return [key, this.parseScalar(value)];
  }

  private parseScalar(value: string): unknown {
    const maybeJson = this.tryParseJson(value);
    return maybeJson.parsed ? maybeJson.value : value;
  }

  private tryParseJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
    try {
      return { parsed: true, value: JSON.parse(value) };
    } catch {
      return { parsed: false };
    }
  }

  private shouldUseJsonValue(value: unknown): boolean {
    return typeof value === "object" && value !== null;
  }

  private inputFieldNames(): string[] {
    const jsonSchema = schemaRenderer.toJsonSchema(this.schema);
    if (!this.isRecord(jsonSchema) || !this.isRecord(jsonSchema.properties)) return [];
    return Object.keys(jsonSchema.properties);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class InputSourceRendererClass {
  render(args: string[]): string {
    return args.map((arg) => this.shellArg(arg)).join(" ");
  }

  private shellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }
}
