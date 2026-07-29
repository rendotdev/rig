import { Context, Effect, Layer, Predicate } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { SchemaRendererService, schemaRendererLayer } from "./schema-renderer";

class ToolInputInterpolationService extends Context.Service<
  ToolInputInterpolationService,
  {
    readonly interpolate: (
      context: Record<string, unknown>,
      value: unknown,
    ) => Effect.Effect<unknown, RigError>;
    readonly interpolateArguments: (
      context: Record<string, unknown>,
      values: string[],
    ) => Effect.Effect<string[], RigError>;
  }
>()("@rendotdev/rig/tools/execution/ToolInputInterpolationService", {
  make: Effect.gen(function* () {
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const lookup = (context: Record<string, unknown>, id: string, path?: string): unknown => {
      if (!(id in context)) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: `Pipeline reference is unknown: @${id}`,
          details: { reference: `@${id}`, available: Object.keys(context) },
        });
      }
      let value = context[id];
      for (const part of path?.split(".").filter(Boolean) ?? []) {
        const cannotTraverseValue = !isRecord(value) && !Array.isArray(value);
        if (cannotTraverseValue) {
          throw new RigError({
            code: "INPUT_ERROR",
            message: `Pipeline reference cannot access: @${id}.${path}`,
            details: { reference: `@${id}.${path}`, missing: part },
          });
        }
        value = (value as Record<string, unknown>)[part];
        if (value === undefined) {
          throw new RigError({
            code: "INPUT_ERROR",
            message: `Pipeline reference is missing: @${id}.${path}`,
            details: { reference: `@${id}.${path}`, missing: part },
          });
        }
      }
      return value;
    };
    const interpolateValue = (context: Record<string, unknown>, value: unknown): unknown => {
      if (typeof value === "string") {
        const exact = value.match(/^@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?$/);
        if (exact) return lookup(context, exact[1]!, exact[2]);
        return value.replace(/@([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?/g, (_match, id, path) =>
          String(lookup(context, id, path)),
        );
      }
      if (Array.isArray(value)) return value.map((item) => interpolateValue(context, item));
      if (!isRecord(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, interpolateValue(context, item)]),
      );
    };
    const interpolate = Effect.fn("ToolInputInterpolationService.interpolate")(function* (
      context: Record<string, unknown>,
      value: unknown,
    ) {
      return yield* Effect.try({ try: () => interpolateValue(context, value), catch: toError });
    });
    const interpolateArguments = Effect.fn("ToolInputInterpolationService.interpolateArguments")(
      function* (context: Record<string, unknown>, values: string[]) {
        return ((yield* interpolate(context, values)) as unknown[]).map(String);
      },
    );
    return { interpolate, interpolateArguments } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolInputInterpolationService,
    ToolInputInterpolationService.make,
  );
}

class ToolInputArgumentService extends Context.Service<
  ToolInputArgumentService,
  {
    readonly parse: (schema: unknown, args: string[]) => Effect.Effect<unknown, RigError>;
    readonly renderSource: (args: string[]) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/execution/ToolInputArgumentService", {
  make: Effect.gen(function* () {
    const schemas = yield* SchemaRendererService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const tryParseJson = (value: string): { parsed: true; value: unknown } | { parsed: false } => {
      try {
        return { parsed: true, value: JSON.parse(value) };
      } catch {
        return { parsed: false };
      }
    };
    const parseScalar = (value: string): unknown => {
      const json = tryParseJson(value);
      return json.parsed ? json.value : value;
    };
    const parsePair = (argument: string): [string, unknown] => {
      const separator = argument.indexOf("=");
      const key = argument.slice(0, separator);
      if (!key) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "Argument keys must not be empty.",
          details: { arg: argument },
        });
      }
      return [key, parseScalar(argument.slice(separator + 1))];
    };
    const parse = Effect.fn("ToolInputArgumentService.parse")(function* (
      schema: unknown,
      args: string[],
    ) {
      if (args.length === 1) {
        const json = tryParseJson(args[0]!);
        const isParsedObject = json.parsed && Predicate.isObject(json.value);
        if (isParsedObject) return json.value;
      }
      if (args.every((argument) => argument.includes("="))) {
        return yield* Effect.try({
          try: () => Object.fromEntries(args.map(parsePair)),
          catch: toError,
        });
      }
      const jsonSchema = yield* schemas.renderJson(schema);
      const fields =
        Predicate.isObject(jsonSchema) && Predicate.isObject(jsonSchema.properties)
          ? Object.keys(jsonSchema.properties)
          : [];
      if (fields.length === 0) {
        if (args.length === 1) return parseScalar(args[0]!);
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: "This command does not declare positional input fields.",
          details: { args },
        });
      }
      if (args.length > fields.length) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: "Too many positional arguments.",
          details: { args, expectedFields: fields },
        });
      }
      return Object.fromEntries(
        args.map((argument, index) => [fields[index], parseScalar(argument)]),
      );
    });
    const renderSource = Effect.fn("ToolInputArgumentService.renderSource")(function* (
      args: string[],
    ) {
      const render = (value: string): string =>
        /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
      return args.map(render).join(" ");
    });
    return { parse, renderSource } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolInputArgumentService, ToolInputArgumentService.make);
}

export class ToolInputParserService extends Context.Service<
  ToolInputParserService,
  {
    readonly interpolate: (
      context: Record<string, unknown>,
      value: unknown,
    ) => Effect.Effect<unknown, RigError>;
    readonly interpolateArguments: (
      context: Record<string, unknown>,
      values: string[],
    ) => Effect.Effect<string[], RigError>;
    readonly parseArguments: (schema: unknown, args: string[]) => Effect.Effect<unknown, RigError>;
    readonly renderSource: (args: string[]) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/execution/ToolInputParserService", {
  make: Effect.gen(function* () {
    const interpolation = yield* ToolInputInterpolationService;
    const argumentsService = yield* ToolInputArgumentService;
    const interpolate = Effect.fn("ToolInputParserService.interpolate")(function* (
      context: Record<string, unknown>,
      value: unknown,
    ) {
      return yield* interpolation.interpolate(context, value);
    });
    const interpolateArguments = Effect.fn("ToolInputParserService.interpolateArguments")(
      function* (context: Record<string, unknown>, values: string[]) {
        return yield* interpolation.interpolateArguments(context, values);
      },
    );
    const parseArguments = Effect.fn("ToolInputParserService.parseArguments")(function* (
      schema: unknown,
      args: string[],
    ) {
      return yield* argumentsService.parse(schema, args);
    });
    const renderSource = Effect.fn("ToolInputParserService.renderSource")(function* (
      args: string[],
    ) {
      return yield* argumentsService.renderSource(args);
    });
    return { interpolate, interpolateArguments, parseArguments, renderSource } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolInputParserService, ToolInputParserService.make);
}

const interpolationLayer = ToolInputInterpolationService.layer;
const argumentLayer = ToolInputArgumentService.layer.pipe(Layer.provide(schemaRendererLayer));
export const toolInputParserLayer = ToolInputParserService.layer.pipe(
  Layer.provide(Layer.merge(interpolationLayer, argumentLayer)),
);
