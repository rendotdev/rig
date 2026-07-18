import { existsSync, lstatSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigConfigStoreClass, type ConfigOptions, type RegistryEntry } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import { RigErrorClass } from "../../errors/RigError";

export type RegistryKind = "base" | "custom";

export const RigToolEntryFiles = ["index.rig.ts", "index.rig.tsx"] as const;

export type ToolDiscoveryOptions = {
  visibleFromPath?: string;
};

export type DiscoveredTool = {
  name: string;
  registryKind: RegistryKind;
  registryPath: string;
  toolDir: string;
  toolPath: string;
};

export class ToolDiscoveryServiceClass {
  private readonly configStore: RigConfigStoreClass;
  private readonly paths: RigPathsClass;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStoreClass(options);
    this.paths = new RigPathsClass(options);
  }

  async discover(options: ToolDiscoveryOptions = {}): Promise<DiscoveredTool[]> {
    const config = await this.configStore.ensure();
    const entries = this.visibleRegistryEntries(
      this.configStore.registryEntries(config),
      options.visibleFromPath,
    );
    const discoveredByRegistry = await Promise.all(
      entries.map((entry) => this.discoverRegistry(entry)),
    );
    const tools = new Map<string, DiscoveredTool>();

    for (const tool of discoveredByRegistry.flat()) {
      const existing = tools.get(tool.name);
      if (existing) {
        throw new RigErrorClass("DUPLICATE_TOOL", `Duplicate tool name: ${tool.name}`, {
          name: tool.name,
          paths: [existing.toolPath, tool.toolPath],
        });
      }

      tools.set(tool.name, tool);
    }

    return [...tools.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async find(name: string): Promise<DiscoveredTool> {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${name}`, { name });
    }
    const config = await this.configStore.ensure();
    const entries = this.configStore.registryEntries(config);
    const discovered = entries
      .map((entry) => this.discoverNamedTool(entry, name))
      .filter((tool): tool is DiscoveredTool => tool !== undefined);
    if (discovered.length > 1) {
      throw new RigErrorClass("DUPLICATE_TOOL", `Duplicate tool name: ${name}`, {
        name,
        paths: discovered.map((tool) => tool.toolPath),
      });
    }
    const tool = discovered[0];
    if (!tool) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${name}`, { name });
    }
    return tool;
  }

  /* v8 ignore start */
  projectRootFor(pathValue: string): string {
    let current = this.visibilityStartDirectory(pathValue);
    let packageRoot: string | undefined;

    while (true) {
      if (existsSync(join(current, ".git"))) return current;
      if (!packageRoot && existsSync(join(current, "package.json"))) packageRoot = current;

      const parent = dirname(current);
      if (parent === current) return packageRoot ?? this.visibilityStartDirectory(pathValue);

      current = parent;
    }
  }
  /* v8 ignore stop */

  private visibleRegistryEntries(
    entries: RegistryEntry[],
    visibleFromPath?: string,
  ): RegistryEntry[] {
    if (!visibleFromPath) return entries;
    // All explicitly-configured registries (base + custom) are always visible.
    // Visibility scoping only applies to future auto-discovered registries.
    return entries;
  }

  /* v8 ignore start */
  private visibilityStartDirectory(pathValue: string): string {
    const absolute = this.paths.resolve(pathValue);
    try {
      const stat = statSync(absolute);
      if (stat.isDirectory()) return absolute;
    } catch {
      // Missing instruction files still scope to their parent directory.
    }

    return dirname(absolute);
  }
  /* v8 ignore stop */

  private discoverNamedTool(entry: RegistryEntry, name: string): DiscoveredTool | undefined {
    const toolDir = join(entry.path, name);
    try {
      if (!lstatSync(toolDir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const toolPaths = RigToolEntryFiles.map((file) => join(toolDir, file)).filter((path) =>
      existsSync(path),
    );
    if (toolPaths.length > 1) {
      throw new RigErrorClass("TOOL_INVALID", `Tool ${name} has multiple Rig entry files.`, {
        toolDir,
        found: toolPaths,
        expected: RigToolEntryFiles,
      });
    }
    if (toolPaths.length === 0) {
      this.rejectLegacyEntry(name, toolDir);
      return undefined;
    }
    return {
      name,
      registryKind: entry.kind,
      registryPath: entry.path,
      toolDir,
      toolPath: toolPaths[0]!,
    };
  }

  private async discoverRegistry(entry: RegistryEntry): Promise<DiscoveredTool[]> {
    if (!existsSync(entry.path)) return [];
    const children = await readdir(entry.path, { withFileTypes: true });
    return children.flatMap((child) => {
      if (!child.isDirectory()) return [];
      const toolDir = join(entry.path, child.name);
      const toolPaths = RigToolEntryFiles.map((file) => join(toolDir, file)).filter((path) =>
        existsSync(path),
      );

      if (toolPaths.length > 1) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Tool ${child.name} has multiple Rig entry files.`,
          {
            toolDir,
            found: toolPaths,
            expected: RigToolEntryFiles,
          },
        );
      }

      if (toolPaths.length === 0) {
        this.rejectLegacyEntry(child.name, toolDir);
        return [];
      }

      return [
        {
          name: child.name,
          registryKind: entry.kind,
          registryPath: entry.path,
          toolDir,
          toolPath: toolPaths[0]!,
        },
      ];
    });
  }

  private rejectLegacyEntry(toolName: string, toolDir: string): void {
    const legacyPath = join(toolDir, "tool.ts");
    if (!existsSync(legacyPath)) return;
    throw new RigErrorClass(
      "TOOL_INVALID",
      `Tool ${toolName} must use index.rig.ts or index.rig.tsx.`,
      {
        toolDir,
        found: legacyPath,
        expected: RigToolEntryFiles,
      },
    );
  }
}
