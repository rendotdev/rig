import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import {
  AtomicFileWriterService,
  atomicFileWriterLayer,
} from "../../../providers/filesystem/atomic-file-writer";
import { RigError } from "../../../providers/errors/rig-error";
import { SchemaRendererService } from "../service/schema-renderer";
import { ToolLoaderService } from "./tool-loader";

type ToolEnvEntry = {
  key: string;
  required: boolean;
  set: boolean;
};

export type ToolEnvResult = {
  tool: string;
  envPath: string;
  updated: boolean;
  entries: ToolEnvEntry[];
  updatedKeys: string[];
  removedKeys: string[];
};

type ToolEnvTarget = { tool: string };
type ToolEnvSchema = {
  safeParse(value: unknown): { success: boolean; error?: { flatten(): unknown } };
};
type ToolEnvResultParameters = {
  target: ToolEnvTarget;
  envPath: string;
  updated: boolean;
  values: Record<string, string>;
  schema: unknown;
  updatedKeys: string[];
  removedKeys: string[];
};

class ToolEnvInputService extends Context.Service<
  ToolEnvInputService,
  {
    readonly parseTarget: (value: string) => Effect.Effect<ToolEnvTarget, RigError>;
    readonly parseKeys: (keys: string[]) => Effect.Effect<string[], RigError>;
    readonly parseAssignments: (
      assignments: string[],
    ) => Effect.Effect<Record<string, string>, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolEnvInputService", {
  make: Effect.gen(function* () {
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const parseKey = (key: string): string => {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return key;
      throw new RigError({
        code: "INPUT_ERROR",
        message: `Env key must be a valid shell variable name: ${key}`,
      });
    };
    const parseAssignment = (assignment: string): [string, string] => {
      const separator = assignment.indexOf("=");
      const key = assignment.slice(0, separator);
      const isValidAssignment = separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
      if (isValidAssignment) {
        return [key, assignment.slice(separator + 1)];
      }
      throw new RigError({
        code: "INPUT_ERROR",
        message: `Env assignment must use KEY=VALUE: ${assignment}`,
      });
    };
    const parseTarget = Effect.fn("ToolEnvInputService.parseTarget")(function* (value: string) {
      return yield* Effect.try({
        try: () => {
          const isValidTarget = value && !value.includes(".");
          if (isValidTarget) return { tool: value };
          throw new RigError({
            code: "INPUT_ERROR",
            message: `Env target must use <tool>: ${value}`,
          });
        },
        catch: toError,
      });
    });
    const parseKeys = Effect.fn("ToolEnvInputService.parseKeys")(function* (keys: string[]) {
      return yield* Effect.try({
        try: () => {
          if (keys.length > 0) return keys.map(parseKey);
          throw new RigError({
            code: "INPUT_ERROR",
            message: "Env remove expects at least one KEY.",
          });
        },
        catch: toError,
      });
    });
    const parseAssignments = Effect.fn("ToolEnvInputService.parseAssignments")(function* (
      assignments: string[],
    ) {
      return yield* Effect.try({
        try: () => Object.fromEntries(assignments.map(parseAssignment)),
        catch: toError,
      });
    });
    return { parseTarget, parseKeys, parseAssignments } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEnvInputService, ToolEnvInputService.make);
}

class ToolEnvDocumentService extends Context.Service<
  ToolEnvDocumentService,
  {
    readonly read: (path: string) => Effect.Effect<Record<string, string>, RigError>;
    readonly write: (path: string, values: Record<string, string>) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolEnvDocumentService", {
  make: Effect.gen(function* () {
    const writer = yield* AtomicFileWriterService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const parseValue = (value: string): string => {
      const trimmed = value.trim();
      if (trimmed.length < 2) return trimmed;
      const isDoubleQuoted = trimmed[0] === '"' && trimmed.at(-1) === '"';
      if (isDoubleQuoted) return JSON.parse(trimmed) as string;
      const isSingleQuoted = trimmed[0] === "'" && trimmed.at(-1) === "'";
      if (isSingleQuoted) return trimmed.slice(1, -1);
      return trimmed;
    };
    const parseLine = (line: string, path: string, lineNumber: number) => {
      const trimmed = line.trim();
      const isBlankOrComment = !trimmed || trimmed.startsWith("#");
      if (isBlankOrComment) return undefined;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (match) return { key: match[1]!, value: parseValue(match[2]!) };
      throw new RigError({
        code: "TOOL_INVALID",
        message: "Invalid .env line.",
        details: { path, line: lineNumber },
      });
    };
    const parseDocument = (source: string, path: string): Record<string, string> => {
      const values: Record<string, string> = {};
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        const parsed = parseLine(line, path, index + 1);
        if (parsed) values[parsed.key] = parsed.value;
      }
      return values;
    };
    const renderValue = (value: string): string =>
      /^[A-Za-z0-9_./:=@%+,-]*$/.test(value) ? value : JSON.stringify(value);
    const serialize = (values: Record<string, string>): string => {
      const lines = Object.entries(values)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${renderValue(value)}`);
      return `${lines.join("\n")}\n`;
    };
    const read = Effect.fn("ToolEnvDocumentService.read")(function* (path: string) {
      return yield* Effect.tryPromise({
        try: async () =>
          existsSync(path) ? parseDocument(await readFile(path, "utf8"), path) : {},
        catch: toError,
      });
    });
    const write = Effect.fn("ToolEnvDocumentService.write")(function* (
      path: string,
      values: Record<string, string>,
    ) {
      yield* writer
        .write(path, serialize(values))
        .pipe(Effect.mapError((error) => toError(error.cause)));
    });
    return { read, write } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEnvDocumentService, ToolEnvDocumentService.make);
}

class ToolEnvResultService extends Context.Service<
  ToolEnvResultService,
  {
    readonly validate: (params: {
      target: ToolEnvTarget;
      envPath: string;
      schema: ToolEnvSchema;
      values: Record<string, string>;
    }) => Effect.Effect<void, RigError>;
    readonly create: (params: ToolEnvResultParameters) => Effect.Effect<ToolEnvResult, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolEnvResultService", {
  make: Effect.gen(function* () {
    const schemas = yield* SchemaRendererService;
    const schemaEntries = Effect.fn("ToolEnvResultService.schemaEntries")(function* (
      schema: unknown,
      values: Record<string, string>,
    ) {
      const jsonSchema = yield* schemas.renderJson(schema);
      const hasNoObjectProperties =
        !Predicate.isObject(jsonSchema) || !Predicate.isObject(jsonSchema.properties);
      if (hasNoObjectProperties) return [];
      const schemaRecord = jsonSchema as Record<string, unknown>;
      const properties = schemaRecord.properties as Record<string, unknown>;
      /* v8 ignore next */
      const required = Array.isArray(schemaRecord.required) ? schemaRecord.required : [];
      return Object.keys(properties)
        .toSorted()
        .map((key) => ({ key, required: required.includes(key), set: values[key] !== undefined }));
    });
    const validate = Effect.fn("ToolEnvResultService.validate")(function* (params: {
      target: ToolEnvTarget;
      envPath: string;
      schema: ToolEnvSchema;
      values: Record<string, string>;
    }) {
      const validation = params.schema.safeParse(params.values);
      if (!validation.success) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Tool ${params.target.tool} env would be invalid.`,
          details: { path: params.envPath, errors: validation.error?.flatten() },
        });
      }
      return undefined;
    });
    const create = Effect.fn("ToolEnvResultService.create")(function* (
      params: ToolEnvResultParameters,
    ) {
      return {
        tool: params.target.tool,
        envPath: params.envPath,
        updated: params.updated,
        entries: yield* schemaEntries(params.schema, params.values),
        updatedKeys: params.updatedKeys.toSorted(),
        removedKeys: params.removedKeys.toSorted(),
      };
    });
    return { validate, create } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEnvResultService, ToolEnvResultService.make);
}

export class ToolEnvService extends Context.Service<
  ToolEnvService,
  {
    readonly configure: (
      target: string,
      assignments?: string[],
    ) => Effect.Effect<ToolEnvResult, RigError>;
  }
>()("@rendotdev/rig/tools/management/ToolEnvService", {
  make: Effect.gen(function* () {
    const loader = yield* ToolLoaderService;
    const input = yield* ToolEnvInputService;
    const documents = yield* ToolEnvDocumentService;
    const results = yield* ToolEnvResultService;
    const configure = Effect.fn("ToolEnvService.configure")(function* (
      targetValue: string,
      assignments: string[] = [],
    ) {
      const target = yield* input.parseTarget(targetValue);
      const loaded = yield* loader.loadDefinition(target.tool);
      const schema = loaded.definition.env;
      if (!schema) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Tool ${target.tool} does not define an env schema.`,
          details: { tool: target.tool },
        });
      }
      const envPath = join(dirname(loaded.path), ".env");
      const existing = yield* documents.read(envPath);
      if (assignments.length === 0) {
        return yield* results.create({
          target,
          envPath,
          updated: false,
          values: existing,
          schema,
          updatedKeys: [],
          removedKeys: [],
        });
      }
      if (assignments[0] === "remove") {
        const keys = yield* input.parseKeys(assignments.slice(1));
        const nextValues = { ...existing };
        const removedKeys = keys.filter((key) => key in nextValues);
        for (const key of keys) delete nextValues[key];
        yield* results.validate({ target, envPath, schema, values: nextValues });
        if (removedKeys.length > 0) yield* documents.write(envPath, nextValues);
        return yield* results.create({
          target,
          envPath,
          updated: removedKeys.length > 0,
          values: nextValues,
          schema,
          updatedKeys: [],
          removedKeys,
        });
      }
      const updates = yield* input.parseAssignments(assignments);
      const nextValues = { ...existing, ...updates };
      yield* results.validate({ target, envPath, schema, values: nextValues });
      yield* documents.write(envPath, nextValues);
      return yield* results.create({
        target,
        envPath,
        updated: true,
        values: nextValues,
        schema,
        updatedKeys: Object.keys(updates),
        removedKeys: [],
      });
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEnvService, ToolEnvService.make);
}

const documentLayer = ToolEnvDocumentService.layer.pipe(Layer.provide(atomicFileWriterLayer));
const resultLayer = ToolEnvResultService.layer;
export const toolEnvLayer = ToolEnvService.layer.pipe(
  Layer.provide(Layer.mergeAll(ToolEnvInputService.layer, documentLayer, resultLayer)),
);
