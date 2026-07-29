import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";

export class CollectionIndexQueryCompilerService extends Context.Service<
  CollectionIndexQueryCompilerService,
  {
    readonly fieldPath: (value: string) => Effect.Effect<string, RigError>;
    readonly where: (values: Record<string, unknown>) => Effect.Effect<
      {
        readonly sql: string;
        readonly parameters: Record<string, unknown>;
      },
      RigError
    >;
  }
>()("@rendotdev/rig/collections/CollectionIndexQueryCompilerService", {
  make: Effect.gen(function* () {
    const fieldPath = Effect.fn("CollectionIndexQueryCompilerService.fieldPath")(function* (
      value: string,
    ) {
      const segments = value.split(".");
      const hasInvalidSegment = segments.some((part) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part));
      const isInvalidPath = value.length === 0 || hasInvalidSegment;
      if (isInvalidPath) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: `Invalid collection field path: ${value}`,
        });
      }
      return `$${segments.map((segment) => `.${segment}`).join("")}`;
    });
    const where = Effect.fn("CollectionIndexQueryCompilerService.where")(function* (
      values: Record<string, unknown>,
    ) {
      const parameters: Record<string, unknown> = {};
      const conditions: string[] = [];
      for (const [index, [key, value]] of Object.entries(values).entries()) {
        const name = `where_${index}`;
        parameters[name] = typeof value === "object" ? JSON.stringify(value) : value;
        conditions.push(`json_extract(data_json, '${yield* fieldPath(key)}') = $${name}`);
      }
      return { sql: conditions.join(" AND "), parameters } as const;
    });
    return { fieldPath, where } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionIndexQueryCompilerService,
    CollectionIndexQueryCompilerService.make,
  );
}
