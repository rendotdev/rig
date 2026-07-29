import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { ErrorCode } from "./codes";

export class RigError extends Schema.TaggedErrorClass<RigError>()("RigError", {
  code: ErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

export class RigErrorNormalizationService extends Context.Service<
  RigErrorNormalizationService,
  { readonly normalize: (cause: unknown) => Effect.Effect<RigError> }
>()("@rendotdev/rig/providers/RigErrorNormalizationService", {
  make: Effect.gen(function* () {
    const find = (cause: unknown, seen: Set<object>): RigError | undefined => {
      if (cause instanceof RigError) return cause;
      const isNonEmptyString = typeof cause === "string" && cause.length > 0;
      if (isNonEmptyString) {
        return new RigError({ code: "INTERNAL_ERROR", message: cause });
      }
      const isUnusableObject = !Predicate.isObject(cause) || seen.has(cause);
      if (isUnusableObject) return undefined;
      seen.add(cause);
      if ("cause" in cause) {
        const nested = find(cause.cause, seen);
        if (nested) return nested;
      }
      const isErrorWithMessage = cause instanceof Error && cause.message.length > 0;
      if (isErrorWithMessage) {
        return new RigError({ code: "INTERNAL_ERROR", message: cause.message });
      }
      const hasStringMessage =
        "message" in cause && typeof cause.message === "string" && cause.message.length > 0;
      if (hasStringMessage) {
        return new RigError({ code: "INTERNAL_ERROR", message: String(cause.message) });
      }
      return undefined;
    };
    const normalize = Effect.fn("RigErrorNormalizationService.normalize")(function* (
      cause: unknown,
    ) {
      return (
        find(cause, new Set()) ??
        new RigError({
          code: "INTERNAL_ERROR",
          message: "Unknown Rig failure.",
        })
      );
    });
    return { normalize } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    RigErrorNormalizationService,
    RigErrorNormalizationService.make,
  );
}

export const rigErrorNormalizationLayer = RigErrorNormalizationService.layer;
