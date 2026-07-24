import { defineService } from "../../define";
import { z } from "zod";

const schemaRendererDeps: {
  toJsonSchema: ((schema: unknown) => unknown) | undefined;
} = {
  toJsonSchema: (z as unknown as { toJSONSchema?: (schema: unknown) => unknown }).toJSONSchema,
};

export class SchemaRendererService extends defineService({ params: {}, deps: schemaRendererDeps }) {
  public toJsonSchema(params: { schema: unknown }): unknown {
    if (typeof this.deps.toJsonSchema !== "function") {
      return { type: "unknown", note: "JSON Schema conversion is unavailable." };
    }

    try {
      return this.deps.toJsonSchema(params.schema);
    } catch {
      return { type: "unknown", note: "JSON Schema conversion failed." };
    }
  }

  public summary(params: { schema: unknown }): string {
    return JSON.stringify(this.toJsonSchema(params), null, 2);
  }
}

export const SchemaRenderer = new SchemaRendererService();

type SchemaRendererConstructor = {
  new (): SchemaRendererClass;
  readonly prototype: SchemaRendererClass;
};

export type SchemaRendererClass = {
  toJsonSchema(schema: unknown): unknown;
  summary(schema: unknown): string;
};

const SchemaRendererClassAdapter = function constructSchemaRenderer(): void {};
Object.defineProperty(SchemaRendererClassAdapter, "name", { value: "SchemaRendererClass" });
Object.defineProperty(SchemaRendererClassAdapter.prototype, "toJsonSchema", {
  configurable: true,
  value: function toJsonSchema(schema: unknown): unknown {
    return SchemaRenderer.toJsonSchema({ schema });
  },
  writable: true,
});
Object.defineProperty(SchemaRendererClassAdapter.prototype, "summary", {
  configurable: true,
  value: function summary(schema: unknown): string {
    return SchemaRenderer.summary({ schema });
  },
  writable: true,
});

export const SchemaRendererClass =
  SchemaRendererClassAdapter as unknown as SchemaRendererConstructor;

export const schemaRenderer = new SchemaRendererClass();
