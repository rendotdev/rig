import { Context, Effect, Layer, Predicate } from "effect";
import { RigError } from "../../../providers/errors/rig-error";

export type CompiledCollectionFieldPath = {
  readonly segments: readonly string[];
  readonly sqliteJsonPath: string;
  readonly read: (value: unknown) => unknown;
};

export class CollectionFieldPathService extends Context.Service<
  CollectionFieldPathService,
  {
    readonly compile: (value: string) => Effect.Effect<CompiledCollectionFieldPath, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionFieldPathService", {
  make: Effect.gen(function* () {
    const invalid = (value: unknown) =>
      new RigError({
        code: "INPUT_ERROR",
        message: `Invalid collection field path: ${String(value)}`,
        details: {
          expected: "dot-separated field names beginning with a letter or underscore",
        },
      });
    const compile = Effect.fn("CollectionFieldPathService.compile")(function* (value: string) {
      const isMissingPath = typeof value !== "string" || value.length === 0;
      if (isMissingPath) {
        return yield* invalid(value);
      }
      const segments = value.split(".");
      if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment))) {
        return yield* invalid(value);
      }
      const read = (input: unknown) => {
        let current = input;
        for (const segment of segments) {
          if (!Predicate.isObject(current)) return undefined;
          current = current[segment];
        }
        return current;
      };
      return {
        segments,
        sqliteJsonPath: `$${segments.map((segment) => `.${segment}`).join("")}`,
        read,
      };
    });
    return { compile } as const;
  }),
}) {
  static readonly layer = Layer.effect(CollectionFieldPathService, CollectionFieldPathService.make);
}
