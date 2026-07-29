import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { ToolIdentifierService } from "../service/tool-identifier";
import type { CommandDefinition, LoadedTool, RigToolKit } from "../types/tool-types";
import { RigToolKitService } from "./tool-sdk";
import { ToolDefinitionService } from "../service/tool-definition";
import { ToolEnvironmentService } from "./tool-environment";

export type LoadedToolDefinition = Omit<LoadedTool, "env">;

export type LoadedToolCommand = Readonly<{
  tool: LoadedTool;
  commandName: string;
  command: CommandDefinition;
}>;

class ToolDiscoveryCacheService extends Context.Service<
  ToolDiscoveryCacheService,
  { readonly find: (name: string) => Effect.Effect<DiscoveredTool, RigError> }
>()("@rendotdev/rig/tools/loading/ToolDiscoveryCacheService", {
  make: Effect.gen(function* () {
    const discovery = yield* ToolDiscoveryService;
    const discoveredTools = new Map<string, DiscoveredTool>();
    const find = Effect.fn("ToolDiscoveryCacheService.find")(function* (name: string) {
      const cached = discoveredTools.get(name);
      if (cached) return cached;
      const discovered = yield* discovery.find(name);
      discoveredTools.set(name, discovered);
      return discovered;
    });
    return { find } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolDiscoveryCacheService, ToolDiscoveryCacheService.make);
}

class ToolDefinitionModuleService extends Context.Service<
  ToolDefinitionModuleService,
  {
    readonly load: (tool: DiscoveredTool) => Effect.Effect<LoadedToolDefinition, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolDefinitionModuleService", {
  make: Effect.gen(function* () {
    const definitionsService = yield* ToolDefinitionService;
    const toolkits = yield* RigToolKitService;
    const definitions = new Map<
      string,
      { modifiedAtMs: number; size: number; value: LoadedToolDefinition }
    >();
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const evaluateDefault = Effect.fn("ToolDefinitionModuleService.evaluateDefault")(function* (
      value: unknown,
      toolName: string,
    ) {
      const awaitedValue = yield* Effect.promise(() => Promise.resolve(value));
      if (typeof awaitedValue !== "function") return awaitedValue;
      const toolkit = yield* toolkits.create();
      return yield* Effect.tryPromise({
        try: () => Promise.resolve((awaitedValue as (toolKit: RigToolKit) => unknown)(toolkit)),
        catch: (error) =>
          new RigError({
            code: "TOOL_INVALID",
            message: `Could not evaluate tool factory ${toolName}.`,
            details: { tool: toolName, error },
          }),
      });
    });
    const load = Effect.fn("ToolDefinitionModuleService.load")(function* (tool: DiscoveredTool) {
      const metadata = yield* Effect.tryPromise({
        try: () => stat(tool.toolPath),
        catch: toError,
      });
      const cached = definitions.get(tool.toolPath);
      const isCurrentDefinition =
        cached?.modifiedAtMs === metadata.mtimeMs && cached.size === metadata.size;
      if (isCurrentDefinition) {
        return cached.value;
      }
      const url = `${pathToFileURL(tool.toolPath).href}?rig=${metadata.mtimeMs}-${metadata.size}`;
      const moduleValue = yield* Effect.tryPromise({
        try: () => import(url) as Promise<unknown>,
        catch: (error) =>
          new RigError({
            code: "TOOL_INVALID",
            message: `Could not load tool ${tool.name}.`,
            details: { path: tool.toolPath, error },
          }),
      });
      const definitionValue = yield* evaluateDefault(
        (moduleValue as { default?: unknown }).default,
        tool.name,
      );
      const definition = yield* definitionsService.decode(definitionValue, tool.name);
      const loaded = { name: definition.name, path: tool.toolPath, definition };
      definitions.set(tool.toolPath, {
        modifiedAtMs: metadata.mtimeMs,
        size: metadata.size,
        value: loaded,
      });
      return loaded;
    });
    return { load } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolDefinitionModuleService,
    ToolDefinitionModuleService.make,
  );
}

export class ToolLoaderService extends Context.Service<
  ToolLoaderService,
  {
    readonly loadDefinition: (name: string) => Effect.Effect<LoadedToolDefinition, RigError>;
    readonly loadDefinitionDiscovered: (
      tool: DiscoveredTool,
    ) => Effect.Effect<LoadedToolDefinition, RigError>;
    readonly loadDiscovered: (tool: DiscoveredTool) => Effect.Effect<LoadedTool, RigError>;
    readonly load: (name: string) => Effect.Effect<LoadedTool, RigError>;
    readonly loadCommand: (
      toolName: string,
      commandName: string,
    ) => Effect.Effect<LoadedToolCommand, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolLoaderService", {
  make: Effect.gen(function* () {
    const environment = yield* ToolEnvironmentService;
    const discovery = yield* ToolDiscoveryCacheService;
    const definitions = yield* ToolDefinitionService;
    const modules = yield* ToolDefinitionModuleService;
    const identifiers = yield* ToolIdentifierService;
    const loadDefinitionDiscovered = Effect.fn("ToolLoaderService.loadDefinitionDiscovered")(
      function* (tool: DiscoveredTool) {
        return yield* modules.load(tool);
      },
    );
    const loadDefinition = Effect.fn("ToolLoaderService.loadDefinition")(function* (name: string) {
      return yield* loadDefinitionDiscovered(yield* discovery.find(name));
    });
    const loadDiscovered = Effect.fn("ToolLoaderService.loadDiscovered")(function* (
      tool: DiscoveredTool,
    ) {
      const loaded = yield* loadDefinitionDiscovered(tool);
      const env = yield* environment.load(tool, loaded.definition);
      return { ...loaded, env };
    });
    const load = Effect.fn("ToolLoaderService.load")(function* (name: string) {
      yield* definitions.validateToolName(name);
      return yield* loadDiscovered(yield* discovery.find(name));
    });
    const loadCommand = Effect.fn("ToolLoaderService.loadCommand")(function* (
      toolName: string,
      commandName: string,
    ) {
      const tool = yield* load(toolName);
      yield* definitions.validateCommandName(commandName);
      const command = tool.definition.commands[commandName];
      if (!command) {
        return yield* new RigError({
          code: "COMMAND_NOT_FOUND",
          message: `Command not found: ${yield* identifiers.commandId(toolName, commandName)}`,
          details: {
            tool: toolName,
            command: commandName,
            available: Object.keys(tool.definition.commands),
          },
        });
      }
      return { tool, commandName, command };
    });
    return { loadDefinition, loadDefinitionDiscovered, loadDiscovered, load, loadCommand } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolLoaderService, ToolLoaderService.make);
}

const toolDiscoveryCacheLayer = ToolDiscoveryCacheService.layer;
const toolDefinitionModuleLayer = ToolDefinitionModuleService.layer;
export const toolLoaderLayer = ToolLoaderService.layer.pipe(
  Layer.provide(Layer.merge(toolDiscoveryCacheLayer, toolDefinitionModuleLayer)),
);
