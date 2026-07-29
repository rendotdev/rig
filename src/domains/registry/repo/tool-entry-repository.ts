import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { RigToolEntryFiles } from "../types/tool-discovery";
import type { RegistryEntry } from "../types/registry";
import type { DiscoveredTool } from "../types/tool-discovery";

export class ToolEntryRepositoryService extends Context.Service<
  ToolEntryRepositoryService,
  {
    readonly inspect: (
      entry: RegistryEntry,
      name: string,
    ) => Effect.Effect<DiscoveredTool | undefined, RigError>;
  }
>()("@rendotdev/rig/registry/ToolEntryRepositoryService", {
  make: Effect.gen(function* () {
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const rejectLegacyEntry = (toolName: string, toolDir: string): void => {
      const legacyPath = join(toolDir, "tool.ts");
      if (!existsSync(legacyPath)) return;
      throw new RigError({
        code: "TOOL_INVALID",
        message: `Tool ${toolName} must use index.rig.ts or index.rig.tsx.`,
        details: { toolDir, found: legacyPath, expected: RigToolEntryFiles },
      });
    };
    const inspect = Effect.fn("ToolEntryRepositoryService.inspect")(function* (
      entry: RegistryEntry,
      name: string,
    ) {
      return yield* Effect.try({
        try: () => {
          const toolDir = join(entry.path, name);
          try {
            if (!lstatSync(toolDir).isDirectory()) return undefined;
          } catch {
            return undefined;
          }
          const toolPaths = RigToolEntryFiles.map((file) => join(toolDir, file)).filter(existsSync);
          if (toolPaths.length > 1) {
            throw new RigError({
              code: "TOOL_INVALID",
              message: `Tool ${name} has multiple Rig entry files.`,
              details: { toolDir, found: toolPaths, expected: RigToolEntryFiles },
            });
          }
          if (toolPaths.length === 0) {
            rejectLegacyEntry(name, toolDir);
            return undefined;
          }
          return {
            name,
            registryKind: entry.kind,
            registryPath: entry.path,
            toolDir,
            toolPath: toolPaths[0]!,
          };
        },
        catch: toError,
      });
    });
    return { inspect } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEntryRepositoryService, ToolEntryRepositoryService.make);
}
