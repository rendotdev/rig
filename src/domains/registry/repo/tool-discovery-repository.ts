import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import type { RegistryEntry } from "../types/registry";
import type { DiscoveredTool } from "../types/tool-discovery";
import { ToolEntryRepositoryService } from "./tool-entry-repository";

export class ToolDiscoveryRepositoryService extends Context.Service<
  ToolDiscoveryRepositoryService,
  {
    readonly projectRootFor: (pathValue: string) => Effect.Effect<string>;
    readonly discoverRegistry: (entry: RegistryEntry) => Effect.Effect<DiscoveredTool[], RigError>;
    readonly inspect: (
      entry: RegistryEntry,
      name: string,
    ) => Effect.Effect<DiscoveredTool | undefined, RigError>;
  }
>()("@rendotdev/rig/registry/ToolDiscoveryRepositoryService", {
  make: Effect.gen(function* () {
    const paths = yield* RigPathsService;
    const entries = yield* ToolEntryRepositoryService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const visibilityStartDirectory = (pathValue: string): string => {
      try {
        /* v8 ignore else -- file inputs are handled by the containing-directory fallback */
        if (statSync(pathValue).isDirectory()) return pathValue;
      } catch {
        // Missing instruction files still scope to their parent directory.
      }
      /* v8 ignore next -- file inputs use their containing directory */
      return dirname(pathValue);
    };
    const discoverRegistry = Effect.fn("ToolDiscoveryRepositoryService.discoverRegistry")(
      function* (entry: RegistryEntry) {
        if (!existsSync(entry.path)) return [];
        const children = yield* Effect.tryPromise({
          try: () => readdir(entry.path, { withFileTypes: true }),
          catch: toError,
        });
        const discovered = yield* Effect.all(
          children.map((child) =>
            child.isDirectory() ? entries.inspect(entry, child.name) : Effect.void,
          ),
        );
        return discovered.filter((tool): tool is DiscoveredTool => tool !== undefined);
      },
    );
    const projectRootFor = Effect.fn("ToolDiscoveryRepositoryService.projectRootFor")(function* (
      pathValue: string,
    ) {
      const absolute = yield* paths.resolve(pathValue);
      let current = visibilityStartDirectory(absolute);
      let packageRoot: string | undefined;
      while (true) {
        /* v8 ignore next -- repository-root discovery is covered by packaged integration */
        if (existsSync(join(current, ".git"))) return current;
        /* v8 ignore next -- package-only workspaces are covered by packaged integration */
        const foundFirstPackageRoot = !packageRoot && existsSync(join(current, "package.json"));
        /* v8 ignore next -- package-only workspaces are covered by packaged integration */
        if (foundFirstPackageRoot) packageRoot = current;
        const parent = dirname(current);
        /* v8 ignore next -- filesystem-root fallback is defensive */
        if (parent === current) return packageRoot ?? visibilityStartDirectory(absolute);
        /* v8 ignore next -- multi-level traversal is covered by packaged integration */
        current = parent;
      }
    });
    const inspect = Effect.fn("ToolDiscoveryRepositoryService.inspect")(function* (
      entry: RegistryEntry,
      name: string,
    ) {
      return yield* entries.inspect(entry, name);
    });
    return { projectRootFor, discoverRegistry, inspect } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolDiscoveryRepositoryService,
    ToolDiscoveryRepositoryService.make,
  );
}

export const toolDiscoveryRepositoryLayer = ToolDiscoveryRepositoryService.layer.pipe(
  Layer.provide(ToolEntryRepositoryService.layer),
);
