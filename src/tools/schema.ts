import { z } from "zod";

export class SchemaRenderer {
  static toJsonSchema(schema: unknown): unknown {
    const converter = (z as unknown as { toJSONSchema?: (schema: unknown) => unknown })
      .toJSONSchema;
    if (typeof converter === "function") {
      try {
        return converter(schema);
      } catch {
        return { type: "unknown", note: "JSON Schema conversion failed." };
      }
    }
    return { type: "unknown", note: "JSON Schema conversion is unavailable." };
  }

  static summary(schema: unknown): string {
    return JSON.stringify(this.toJsonSchema(schema), null, 2);
  }
}
