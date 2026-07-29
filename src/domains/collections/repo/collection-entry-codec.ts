import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { CollectionData } from "../types/collection-operation-context";
import type { CollectionDefinition, CollectionEntry, DocRow } from "../types/tool-collection";

export class CollectionEntryCodecService extends Context.Service<
  CollectionEntryCodecService,
  {
    readonly validate: (
      definition: CollectionDefinition,
      data: unknown,
    ) => Effect.Effect<CollectionData, RigError>;
    readonly deriveId: (
      definition: CollectionDefinition,
      data: CollectionData,
    ) => Effect.Effect<string | undefined>;
    readonly rowToEntry: (row: DocRow) => Effect.Effect<CollectionEntry<CollectionData>>;
    readonly snippet: (body: string, query: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/collections/CollectionEntryCodecService", {
  make: Effect.gen(function* () {
    const validate = Effect.fn("CollectionEntryCodecService.validate")(function* (
      definition: CollectionDefinition,
      data: unknown,
    ) {
      if (!definition.schema) return data as CollectionData;
      const result = definition.schema.safeParse(data);
      if (result.success) return result.data as CollectionData;
      return yield* new RigError({
        code: "VALIDATION_ERROR",
        message: "Collection entry data is invalid.",
        details: { errors: result.error.flatten() },
      });
    });
    const deriveId = Effect.fn("CollectionEntryCodecService.deriveId")(function* (
      definition: CollectionDefinition,
      data: CollectionData,
    ) {
      if (definition.generateId) return definition.generateId(data);
      const candidate = data.id ?? data.slug ?? data.title;
      return typeof candidate === "string"
        ? candidate
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
        : undefined;
    });
    const rowToEntry = Effect.fn("CollectionEntryCodecService.rowToEntry")(function* (row: DocRow) {
      return {
        id: row.id,
        data: JSON.parse(row.data_json) as CollectionData,
        body: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    const snippet = Effect.fn("CollectionEntryCodecService.snippet")(function* (
      body: string,
      query: string,
    ) {
      const words = query.toLowerCase().split(/\s+/);
      return (
        body
          .split("\n")
          .find((line) => words.some((word) => line.toLowerCase().includes(word)))
          ?.slice(0, 200) ?? body.slice(0, 150)
      );
    });
    return { validate, deriveId, rowToEntry, snippet } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionEntryCodecService,
    CollectionEntryCodecService.make,
  );
}
