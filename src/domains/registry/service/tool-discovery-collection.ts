import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { DiscoveredTool } from "../types/tool-discovery";

export class ToolDiscoveryCollectionService extends Context.Service<
  ToolDiscoveryCollectionService,
  {
    readonly unique: (
      discoveredByRegistry: DiscoveredTool[][],
    ) => Effect.Effect<DiscoveredTool[], RigError>;
  }
>()("@rendotdev/rig/registry/ToolDiscoveryCollectionService", {
  make: Effect.gen(function* () {
    const unique = Effect.fn("ToolDiscoveryCollectionService.unique")(function* (
      discoveredByRegistry: DiscoveredTool[][],
    ) {
      const tools = new Map<string, DiscoveredTool>();
      for (const tool of discoveredByRegistry.flat()) {
        const existing = tools.get(tool.name);
        if (existing) {
          return yield* new RigError({
            code: "DUPLICATE_TOOL",
            message: `Duplicate tool name: ${tool.name}`,
            details: { name: tool.name, paths: [existing.toolPath, tool.toolPath] },
          });
        }
        tools.set(tool.name, tool);
      }
      return [...tools.values()].toSorted((left, right) => left.name.localeCompare(right.name));
    });
    return { unique } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolDiscoveryCollectionService,
    ToolDiscoveryCollectionService.make,
  );
}
