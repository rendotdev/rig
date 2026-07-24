import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  schemaRenderer,
  SchemaRendererClass,
  SchemaRendererService,
  SchemaRenderer,
} from "./schema-renderer";

describe("schema rendering", () => {
  it("renders injected JSON schemas and summaries", () => {
    const Renderer = new SchemaRendererService({
      params: {},
      deps: {
        toJsonSchema(schema) {
          return { type: "injected", schema };
        },
      },
    });

    expect(Renderer.toJsonSchema({ schema: "value" })).toEqual({
      type: "injected",
      schema: "value",
    });
    expect(Renderer.summary({ schema: "value" })).toBe(
      JSON.stringify({ type: "injected", schema: "value" }, null, 2),
    );
  });

  it("reports unavailable and failed conversion", () => {
    const UnavailableRenderer = new SchemaRendererService({
      params: {},
      deps: { toJsonSchema: undefined },
    });
    const FailedRenderer = new SchemaRendererService({
      params: {},
      deps: {
        toJsonSchema() {
          throw new Error("failed");
        },
      },
    });

    expect(UnavailableRenderer.toJsonSchema({ schema: {} })).toEqual({
      type: "unknown",
      note: "JSON Schema conversion is unavailable.",
    });
    expect(FailedRenderer.toJsonSchema({ schema: {} })).toEqual({
      type: "unknown",
      note: "JSON Schema conversion failed.",
    });
  });

  it("preserves the production value and positional adapters", () => {
    const adapter = new SchemaRendererClass();
    const schema = z.object({ title: z.string() });

    expect(adapter).toBeInstanceOf(SchemaRendererClass);
    expect(adapter.summary(schema)).toContain("title");
    expect(schemaRenderer.summary(schema)).toBe(SchemaRenderer.summary({ schema }));
  });
});
