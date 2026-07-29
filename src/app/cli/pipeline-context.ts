import { readFileSync } from "node:fs";
import { Context, Effect, Layer, Predicate } from "effect";
import { RigError } from "../../providers/errors/rig-error";

export class PipelineInputPlatformService extends Context.Service<
  PipelineInputPlatformService,
  {
    readonly readStdin: Effect.Effect<string, RigError>;
    readonly parseJson: (text: string) => Effect.Effect<unknown, RigError>;
  }
>()("@rendotdev/rig/application/PipelineInputPlatformService", {
  make: Effect.gen(function* () {
    const normalizeError = (cause: unknown): RigError => {
      if (cause instanceof RigError) return cause;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    };
    const readStdin = Effect.try({
      /* v8 ignore next -- production stdin is exercised by CLI integration */
      try: () => readFileSync(0, "utf8"),
      catch: normalizeError,
    }).pipe(Effect.withSpan("PipelineInputPlatformService.readStdin"));
    const parseJson = Effect.fn("PipelineInputPlatformService.parseJson")(function* (text: string) {
      return yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: normalizeError });
    });
    return { readStdin, parseJson } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    PipelineInputPlatformService,
    PipelineInputPlatformService.make,
  );
}

export class PipelineInputService extends Context.Service<
  PipelineInputService,
  {
    readonly read: Effect.Effect<Record<string, unknown>, RigError>;
    readonly query: (value: unknown, path: string) => Effect.Effect<unknown, RigError>;
    readonly attach: (
      envelope: unknown,
      context: Record<string, unknown>,
      id?: string,
    ) => Effect.Effect<unknown, RigError>;
  }
>()("@rendotdev/rig/application/PipelineInputService", {
  make: Effect.gen(function* () {
    const platform = yield* PipelineInputPlatformService;
    const normalizeError = (cause: unknown): RigError => {
      if (cause instanceof RigError) return cause;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    };

    const queryValue = (value: unknown, path: string): unknown => {
      let current = value;
      for (const part of path.split(".").filter(Boolean)) {
        const cannotReadProperty = !Predicate.isObject(current) && !Array.isArray(current);
        if (cannotReadProperty) {
          throw new RigError({
            code: "INPUT_ERROR",
            message: `Query cannot access: ${path}`,
            details: { path, missing: part },
          });
        }
        current = (current as Record<string, unknown>)[part];
        if (current === undefined) {
          throw new RigError({
            code: "INPUT_ERROR",
            message: `Query is missing: ${path}`,
            details: { path, missing: part },
          });
        }
      }
      return current;
    };

    const attachValue = (
      envelope: unknown,
      context: Record<string, unknown>,
      id?: string,
    ): unknown => {
      if (!id) return envelope;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: `Pipeline id is invalid: ${id}`,
          details: { id },
        });
      }
      if (!Predicate.isObject(envelope)) return envelope;
      return { ...envelope, pipe: { ...context, [id]: envelope.data } };
    };

    const read = Effect.gen(function* () {
      const text = (yield* platform.readStdin).trim();
      if (!text) return {};
      const envelope = yield* platform.parseJson(text);
      const context =
        Predicate.isObject(envelope) && Predicate.isObject(envelope.pipe)
          ? { ...envelope.pipe }
          : {};
      context.prev = yield* Effect.try({
        try: () => queryValue(envelope, "data"),
        catch: normalizeError,
      });
      return context;
    }).pipe(Effect.withSpan("PipelineInputService.read"));

    const query = Effect.fn("PipelineInputService.query")(function* (value: unknown, path: string) {
      return yield* Effect.try({ try: () => queryValue(value, path), catch: normalizeError });
    });

    const attach = Effect.fn("PipelineInputService.attach")(function* (
      envelope: unknown,
      context: Record<string, unknown>,
      id?: string,
    ) {
      return yield* Effect.try({
        try: () => attachValue(envelope, context, id),
        catch: normalizeError,
      });
    });

    return { read, query, attach } as const;
  }),
}) {
  static readonly layer = Layer.effect(PipelineInputService, PipelineInputService.make);
}

export const pipelineInputLayer = PipelineInputService.layer.pipe(
  Layer.provide(PipelineInputPlatformService.layer),
);
