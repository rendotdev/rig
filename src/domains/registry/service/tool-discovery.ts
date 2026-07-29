import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import {
  ToolDiscoveryRepositoryService,
  toolDiscoveryRepositoryLayer,
} from "../repo/tool-discovery-repository";
import type { RegistryEntry } from "../types/registry";
import type { DiscoveredTool, ToolDiscoveryOptions } from "../types/tool-discovery";
import { RegistryService } from "./registry";
import { ToolDiscoveryCollectionService } from "./tool-discovery-collection";

export class ToolDiscoveryService extends Context.Service<
  ToolDiscoveryService,
  {
    readonly discover: (
      options?: ToolDiscoveryOptions,
    ) => Effect.Effect<DiscoveredTool[], RigError>;
    readonly discoverRegistry: (entry: RegistryEntry) => Effect.Effect<DiscoveredTool[], RigError>;
    readonly find: (name: string) => Effect.Effect<DiscoveredTool, RigError>;
    readonly projectRootFor: (pathValue: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/registry/ToolDiscoveryService", {
  make: Effect.gen(function* () {
    const registryConfig = yield* RegistryService;
    const repository = yield* ToolDiscoveryRepositoryService;
    const collections = yield* ToolDiscoveryCollectionService;
    const visibleRegistryEntries = (params: {
      entries: RegistryEntry[];
      visibleFromPath?: string;
    }): RegistryEntry[] => {
      if (!params.visibleFromPath) return params.entries;
      return params.entries;
    };
    const projectRootFor = Effect.fn("ToolDiscoveryService.projectRootFor")(function* (
      pathValue: string,
    ) {
      return yield* repository.projectRootFor(pathValue);
    });
    const discoverRegistry = Effect.fn("ToolDiscoveryService.discoverRegistry")(function* (
      entry: RegistryEntry,
    ) {
      return yield* repository.discoverRegistry(entry);
    });
    const discover = Effect.fn("ToolDiscoveryService.discover")(function* (
      options: ToolDiscoveryOptions = {},
    ) {
      const config = yield* registryConfig.list;
      const entries = visibleRegistryEntries({
        entries: config.registries,
        visibleFromPath: options.visibleFromPath,
      });
      const discoveredByRegistry = yield* Effect.all(entries.map(discoverRegistry), {
        concurrency: "unbounded",
      });
      return yield* collections.unique(discoveredByRegistry);
    });
    const find = Effect.fn("ToolDiscoveryService.find")(function* (name: string) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return yield* new RigError({
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${name}`,
          details: { name },
        });
      }
      const config = yield* registryConfig.list;
      const inspected = yield* Effect.all(
        config.registries.map((entry) => repository.inspect(entry, name)),
      );
      const discovered = inspected.filter((tool): tool is DiscoveredTool => tool !== undefined);
      if (discovered.length > 1) {
        return yield* new RigError({
          code: "DUPLICATE_TOOL",
          message: `Duplicate tool name: ${name}`,
          details: { name, paths: discovered.map((tool) => tool.toolPath) },
        });
      }
      const tool = discovered[0];
      if (!tool) {
        return yield* new RigError({
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${name}`,
          details: { name },
        });
      }
      return tool;
    });
    return { discover, discoverRegistry, find, projectRootFor } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolDiscoveryService, ToolDiscoveryService.make);
}

export const toolDiscoveryLayer = ToolDiscoveryService.layer.pipe(
  Layer.provide(Layer.merge(toolDiscoveryRepositoryLayer, ToolDiscoveryCollectionService.layer)),
);
