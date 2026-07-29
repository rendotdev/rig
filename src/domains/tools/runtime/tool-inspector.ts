import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { SchemaRendererService } from "../service/schema-renderer";
import { ToolIdentifierService } from "../service/tool-identifier";
import type { CommandDefinition } from "../types/tool-types";
import { ToolLoaderService } from "./tool-loader";

export class ToolInspectorService extends Context.Service<
  ToolInspectorService,
  {
    readonly inspect: (toolName: string, commandName?: string) => Effect.Effect<unknown, RigError>;
  }
>()("@rendotdev/rig/tools/presentation/ToolInspectorService", {
  make: Effect.gen(function* () {
    const loader = yield* ToolLoaderService;
    const identifiers = yield* ToolIdentifierService;
    const schemas = yield* SchemaRendererService;
    const inspectTarget = Effect.fn("ToolInspectorService.inspectTarget")(function* (
      toolName: string,
      commandName?: string,
    ) {
      if (commandName) {
        const target = yield* identifiers.makeCommandTarget(toolName, commandName);
        return { toolName: target.tool, commandName: target.command };
      }
      if (!toolName.includes(".")) {
        return { toolName: (yield* identifiers.parseToolName(toolName)).value };
      }
      const target = yield* identifiers.parseCommandTarget(toolName);
      return { toolName: target.tool, commandName: target.command };
    });
    const commandMetadata = Effect.fn("ToolInspectorService.commandMetadata")(function* (
      toolName: string,
      name: string,
      command: CommandDefinition,
    ) {
      const id = yield* identifiers.commandId(toolName, name);
      return {
        name,
        id,
        description: command.description,
        inputSchema: yield* schemas.renderJson(command.input),
        outputSchema: yield* schemas.renderJson(command.output),
        run: `rig run ${id} [args...]`,
        examples: command.examples ?? [],
      };
    });
    const inspect = Effect.fn("ToolInspectorService.inspect")(function* (
      toolName: string,
      commandName?: string,
    ) {
      const target = yield* inspectTarget(toolName, commandName);
      const loaded = yield* loader.loadDefinition(target.toolName);
      const definition = loaded.definition;
      if (target.commandName) {
        const command = definition.commands[target.commandName];
        if (!command) {
          return yield* new RigError({
            code: "COMMAND_NOT_FOUND",
            message: `Command not found: ${yield* identifiers.commandId(target.toolName, target.commandName)}`,
            details: {
              tool: target.toolName,
              command: target.commandName,
              available: Object.keys(definition.commands),
            },
          });
        }
        return {
          tool: definition.name,
          command: target.commandName,
          path: loaded.path,
          ...(yield* commandMetadata(definition.name, target.commandName, command)),
        };
      }
      return {
        name: definition.name,
        description: definition.description,
        path: loaded.path,
        commands: yield* Effect.all(
          Object.entries(definition.commands).map(([name, command]) =>
            commandMetadata(definition.name, name, command),
          ),
        ),
      };
    });
    return { inspect } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolInspectorService, ToolInspectorService.make);
}
