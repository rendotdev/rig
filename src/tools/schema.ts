import { z } from "zod";

export class SchemaRenderer {
  static toJsonSchema(schema: unknown): unknown {
    const converter = (z as unknown as { toJSONSchema?: (schema: unknown) => unknown })
      .toJSONSchema;
    /* v8 ignore next */
    if (typeof converter !== "function") {
      return { type: "unknown", note: "JSON Schema conversion is unavailable." };
    }

    try {
      return converter(schema);
    } catch {
      return { type: "unknown", note: "JSON Schema conversion failed." };
    }
  }

  static summary(schema: unknown): string {
    return JSON.stringify(this.toJsonSchema(schema), null, 2);
  }
}
