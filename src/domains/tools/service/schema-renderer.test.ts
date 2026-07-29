import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { z } from "zod";
import { SchemaRendererService, schemaRendererLayer } from "./schema-renderer";

const injectedConverter = (schema: unknown) => ({ type: "injected", schema });

describe("schema rendering", () => {
  it("renders injected JSON schemas and summaries", async () => {
    const renderer = await Effect.runPromise(
      SchemaRendererService.use(Effect.succeed).pipe(Effect.provide(schemaRendererLayer)),
    );
    await expect(
      Effect.runPromise(renderer.renderJson("value", injectedConverter)),
    ).resolves.toEqual({
      type: "injected",
      schema: "value",
    });
    await expect(
      Effect.runPromise(renderer.renderSummary("value", injectedConverter)),
    ).resolves.toBe(JSON.stringify({ type: "injected", schema: "value" }, null, 2));
  });

  it("reports unavailable and failed conversion", async () => {
    const renderer = await Effect.runPromise(
      SchemaRendererService.use(Effect.succeed).pipe(Effect.provide(schemaRendererLayer)),
    );
    await expect(Effect.runPromise(renderer.renderJson({}, null))).resolves.toEqual({
      type: "unknown",
      note: "JSON Schema conversion is unavailable.",
    });
    await expect(
      Effect.runPromise(
        renderer.renderJson({}, () => {
          throw new Error("failed");
        }),
      ),
    ).resolves.toEqual({
      type: "unknown",
      note: "JSON Schema conversion failed.",
    });
  });

  it("renders production Zod schemas", async () => {
    await expect(
      Effect.runPromise(
        SchemaRendererService.use((service) =>
          service.renderSummary(z.object({ title: z.string() })),
        ).pipe(Effect.provide(schemaRendererLayer)),
      ),
    ).resolves.toContain("title");
  });
});
