import { Context, Effect, Layer, Schema } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { CollectionName, CommandName, CommandTarget, ToolName } from "../types/tool-identifier";

export class ToolIdentifierService extends Context.Service<
  ToolIdentifierService,
  {
    readonly parseToolName: (value: unknown) => Effect.Effect<ToolName, RigError>;
    readonly parseCommandName: (value: unknown) => Effect.Effect<CommandName, RigError>;
    readonly parseCollectionName: (value: unknown) => Effect.Effect<CollectionName, RigError>;
    readonly makeCommandTarget: (
      tool: unknown,
      command: unknown,
    ) => Effect.Effect<CommandTarget, RigError>;
    readonly parseCommandTarget: (id: unknown) => Effect.Effect<CommandTarget, RigError>;
    readonly commandId: (tool: unknown, command: unknown) => Effect.Effect<string, RigError>;
  }
>()("@rendotdev/rig/tools/domain/ToolIdentifierService", {
  make: Effect.gen(function* () {
    const decodeName = <Entity>(params: {
      schema: Schema.Codec<Entity, unknown, never, never>;
      value: unknown;
      kind: "tool" | "command" | "collection";
    }): Entity => {
      try {
        return Schema.decodeUnknownSync(params.schema)({ value: params.value });
      } catch {
        throw new RigError({
          code: "TOOL_INVALID",
          message: `Invalid ${params.kind} name: ${String(params.value)}`,
          details: { expected: "letters, numbers, hyphens, or underscores" },
        });
      }
    };
    const parseToolName = Effect.fn("ToolIdentifierService.parseToolName")(function* (
      value: unknown,
    ) {
      return yield* Effect.try({
        try: () => decodeName({ schema: ToolName, value, kind: "tool" }),
        catch: (cause) => cause as RigError,
      });
    });
    const parseCommandName = Effect.fn("ToolIdentifierService.parseCommandName")(function* (
      value: unknown,
    ) {
      return yield* Effect.try({
        try: () => decodeName({ schema: CommandName, value, kind: "command" }),
        catch: (cause) => cause as RigError,
      });
    });
    const parseCollectionName = Effect.fn("ToolIdentifierService.parseCollectionName")(function* (
      value: unknown,
    ) {
      return yield* Effect.try({
        try: () => decodeName({ schema: CollectionName, value, kind: "collection" }),
        catch: (cause) => cause as RigError,
      });
    });
    const makeCommandTarget = Effect.fn("ToolIdentifierService.makeCommandTarget")(function* (
      tool: unknown,
      command: unknown,
    ) {
      const parsedTool = (yield* parseToolName(tool)).value;
      const parsedCommand = (yield* parseCommandName(command)).value;
      return new CommandTarget({
        tool: parsedTool,
        command: parsedCommand,
        id: `${parsedTool}.${parsedCommand}`,
      });
    });
    const parseCommandTarget = Effect.fn("ToolIdentifierService.parseCommandTarget")(function* (
      id: unknown,
    ) {
      if (typeof id === "string") {
        const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(id);
        if (match) return yield* makeCommandTarget(match[1], match[2]);
      }
      return yield* new RigError({
        code: "INPUT_ERROR",
        message: `Command id must use <tool>.<command>: ${String(id)}`,
      });
    });
    const commandId = Effect.fn("ToolIdentifierService.commandId")(function* (
      tool: unknown,
      command: unknown,
    ) {
      return (yield* makeCommandTarget(tool, command)).id;
    });
    return {
      parseToolName,
      parseCommandName,
      parseCollectionName,
      makeCommandTarget,
      parseCommandTarget,
      commandId,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolIdentifierService, ToolIdentifierService.make);
}

export const toolIdentifierLayer = ToolIdentifierService.layer;
