import { Context, Effect, Layer, Predicate } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolIdentifierService, toolIdentifierLayer } from "./tool-identifier";
import type { ToolDefinition } from "../types/tool-types";

class ToolDefinitionFieldsService extends Context.Service<
  ToolDefinitionFieldsService,
  {
    readonly validateSchema: (
      value: unknown,
      role: string,
      id: string,
    ) => Effect.Effect<void, RigError>;
    readonly validateExamples: (value: unknown, path: string) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolDefinitionFieldsService", {
  make: Effect.gen(function* () {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const validateSchema = Effect.fn("ToolDefinitionFieldsService.validateSchema")(function* (
      value: unknown,
      role: string,
      id: string,
    ) {
      const isInvalidSchema = !isRecord(value) || typeof value.safeParse !== "function";
      if (isInvalidSchema) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Command ${id} needs a Zod schema for ${role}.`,
          details: { expected: "rig.z.object({ ... })" },
        });
      }
      return undefined;
    });
    const validateExamples = Effect.fn("ToolDefinitionFieldsService.validateExamples")(function* (
      value: unknown,
      path: string,
    ) {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Invalid examples at ${path}.`,
          details: { expected: "array" },
        });
      }
      for (const [index, example] of value.entries()) {
        if (!isRecord(example)) {
          return yield* new RigError({
            code: "TOOL_INVALID",
            message: `Invalid example at ${path}[${index}].`,
            details: { expected: "object" },
          });
        }
        const hasInvalidTitle = typeof example.title !== "string" || example.title.length === 0;
        if (hasInvalidTitle) {
          return yield* new RigError({
            code: "TOOL_INVALID",
            message: `Invalid example title at ${path}[${index}].`,
            details: { expected: "non-empty string" },
          });
        }
        const hasInvalidText = typeof example.text !== "string" || example.text.length === 0;
        if (hasInvalidText) {
          return yield* new RigError({
            code: "TOOL_INVALID",
            message: `Invalid example text at ${path}[${index}].`,
            details: { expected: "non-empty string" },
          });
        }
      }
      return undefined;
    });
    return { validateSchema, validateExamples } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolDefinitionFieldsService,
    ToolDefinitionFieldsService.make,
  );
}

class ToolCommandDefinitionService extends Context.Service<
  ToolCommandDefinitionService,
  {
    readonly validate: (
      commandName: string,
      value: unknown,
      toolName: string,
    ) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolCommandDefinitionService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const fields = yield* ToolDefinitionFieldsService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const validate = Effect.fn("ToolCommandDefinitionService.validate")(function* (
      commandName: string,
      value: unknown,
      toolName: string,
    ) {
      yield* identifiers.parseCommandName(commandName);
      const id = yield* identifiers.commandId(toolName, commandName);
      if (!isRecord(value)) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Invalid command ${id}.`,
          details: { expected: "object" },
        });
      }
      const hasMissingDescription =
        typeof value.description !== "string" || value.description.length === 0;
      if (hasMissingDescription) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Command ${id} needs a description.`,
          details: { expected: "non-empty string" },
        });
      }
      yield* fields.validateSchema(value.input, "input", id);
      yield* fields.validateSchema(value.output, "output", id);
      yield* fields.validateExamples(value.examples, `${id}.examples`);
      if (typeof value.run !== "function") {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Command ${id} needs a run function.`,
          details: { expected: "function" },
        });
      }
      return undefined;
    });
    return { validate } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolCommandDefinitionService,
    ToolCommandDefinitionService.make,
  );
}

export class ToolDefinitionService extends Context.Service<
  ToolDefinitionService,
  {
    readonly validateToolName: (name: string) => Effect.Effect<void, RigError>;
    readonly validateCommandName: (name: string) => Effect.Effect<void, RigError>;
    readonly decode: (
      value: unknown,
      expectedName?: string,
    ) => Effect.Effect<ToolDefinition, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolDefinitionService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const decoder = yield* ToolDefinitionDecoderService;
    const validateToolName = Effect.fn("ToolDefinitionService.validateToolName")(function* (
      name: string,
    ) {
      yield* identifiers.parseToolName(name);
    });
    const validateCommandName = Effect.fn("ToolDefinitionService.validateCommandName")(function* (
      name: string,
    ) {
      yield* identifiers.parseCommandName(name);
    });
    const decode = Effect.fn("ToolDefinitionService.decode")(function* (
      value: unknown,
      expectedName?: string,
    ) {
      return yield* decoder.decode(value, expectedName);
    });
    return { validateToolName, validateCommandName, decode } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolDefinitionService, ToolDefinitionService.make);
}

class ToolDefinitionDecoderService extends Context.Service<
  ToolDefinitionDecoderService,
  {
    readonly decode: (
      value: unknown,
      expectedName?: string,
    ) => Effect.Effect<ToolDefinition, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolDefinitionDecoderService", {
  make: Effect.gen(function* () {
    const identifiers = yield* ToolIdentifierService;
    const fields = yield* ToolDefinitionFieldsService;
    const commands = yield* ToolCommandDefinitionService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const invalidTool = (message: string, details?: unknown) =>
      new RigError({ code: "TOOL_INVALID", message, details });
    const decode = Effect.fn("ToolDefinitionDecoderService.decode")(function* (
      value: unknown,
      expectedName?: string,
    ) {
      if (!isRecord(value)) {
        return yield* invalidTool("Tool default export must be an object.");
      }
      const name =
        typeof value.name === "string" && value.name.length > 0 ? value.name : expectedName;
      if (!name) {
        return yield* invalidTool("Tool needs a name.", {
          expected: "non-empty string or a discovered tool folder",
        });
      }
      yield* identifiers.parseToolName(name);
      const doesNameMismatchFolder = expectedName !== undefined && name !== expectedName;
      if (doesNameMismatchFolder) {
        return yield* invalidTool(
          `Tool name does not match its folder: ${name} should be ${expectedName}.`,
          { expectedName, actualName: name },
        );
      }
      const hasMissingDescription =
        typeof value.description !== "string" || value.description.length === 0;
      if (hasMissingDescription) {
        return yield* invalidTool(`Tool ${name} needs a description.`, {
          expected: "non-empty string",
        });
      }
      const hasInvalidDatabaseSetup =
        value.setupDb !== undefined && typeof value.setupDb !== "function";
      if (hasInvalidDatabaseSetup) {
        return yield* invalidTool(`Tool ${name} setupDb must be a function.`, {
          expected: "function",
        });
      }
      if (value.env !== undefined) yield* fields.validateSchema(value.env, "env", name);
      if (value.collections !== undefined) {
        if (!isRecord(value.collections)) {
          return yield* invalidTool(`Tool ${name} needs a collections object.`, {
            expected: "object",
          });
        }
        yield* Effect.all(Object.keys(value.collections).map(identifiers.parseCollectionName));
      }
      const hasNoCommands = !isRecord(value.commands) || Object.keys(value.commands).length === 0;
      if (hasNoCommands) {
        const message = isRecord(value.commands)
          ? `Tool ${name} must define at least one command.`
          : `Tool ${name} needs a commands object.`;
        return yield* invalidTool(
          message,
          isRecord(value.commands) ? undefined : { expected: "object" },
        );
      }
      const commandDefinitions = value.commands as Record<string, unknown>;
      yield* Effect.all(
        Object.entries(commandDefinitions).map(([commandName, command]) =>
          commands.validate(commandName, command, name),
        ),
      );
      return (value.name === name ? value : { ...value, name }) as ToolDefinition;
    });
    return { decode } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolDefinitionDecoderService,
    ToolDefinitionDecoderService.make,
  );
}

const fieldsLayer = ToolDefinitionFieldsService.layer;
const commandLayer = ToolCommandDefinitionService.layer.pipe(
  Layer.provide(Layer.merge(toolIdentifierLayer, fieldsLayer)),
);
const decoderLayer = ToolDefinitionDecoderService.layer.pipe(
  Layer.provide(Layer.mergeAll(toolIdentifierLayer, fieldsLayer, commandLayer)),
);
export const toolDefinitionLayer = ToolDefinitionService.layer.pipe(
  Layer.provide(Layer.merge(toolIdentifierLayer, decoderLayer)),
);
