import { Context, Effect, Layer, Result } from "effect";
import { z } from "zod";

export type JsonSchemaConverter = (schema: unknown) => unknown;

export class SchemaRendererService extends Context.Service<
  SchemaRendererService,
  {
    readonly renderJson: (
      schema: unknown,
      converter?: JsonSchemaConverter | null,
    ) => Effect.Effect<unknown>;
    readonly renderSummary: (
      schema: unknown,
      converter?: JsonSchemaConverter | null,
    ) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/domain/SchemaRendererService", {
  make: Effect.gen(function* () {
    const defaultJsonSchemaConverter = (z as unknown as { toJSONSchema?: JsonSchemaConverter })
      .toJSONSchema;
    const renderJson = Effect.fn("SchemaRendererService.renderJson")(function* (
      schema: unknown,
      converter: JsonSchemaConverter | null | undefined = defaultJsonSchemaConverter,
    ) {
      if (typeof converter !== "function") {
        return { type: "unknown", note: "JSON Schema conversion is unavailable." };
      }
      const converted = yield* Effect.result(
        Effect.try({ try: () => converter(schema), catch: () => undefined }),
      );
      return Result.isSuccess(converted)
        ? converted.success
        : { type: "unknown", note: "JSON Schema conversion failed." };
    });
    const renderSummary = Effect.fn("SchemaRendererService.renderSummary")(function* (
      schema: unknown,
      converter?: JsonSchemaConverter | null,
    ) {
      return JSON.stringify(yield* renderJson(schema, converter), null, 2);
    });
    return { renderJson, renderSummary } as const;
  }),
}) {
  static readonly layer = Layer.effect(SchemaRendererService, SchemaRendererService.make);
}

export const schemaRendererLayer = SchemaRendererService.layer;
