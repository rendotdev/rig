import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RigConfigStore, type ConfigOptions, type RegistryEntry } from "../config/config";
import { RigPaths } from "../config/paths";
import { RigError } from "../errors/RigError";

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

export class ToolDiscoveryService {
  private readonly configStore: RigConfigStore;
  private readonly paths: RigPaths;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStore(options);
    this.paths = new RigPaths(options);
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
        throw new RigError("DUPLICATE_TOOL", `Duplicate tool name: ${tool.name}`, {
          name: tool.name,
          paths: [existing.toolPath, tool.toolPath],
        });
      }

      tools.set(tool.name, tool);
    }

    return [...tools.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async find(name: string): Promise<DiscoveredTool> {
    const tools = await this.discover();
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) {
      throw new RigError("TOOL_NOT_FOUND", `Tool not found: ${name}`, { name });
    }
    return tool;
  }

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

  private visibleRegistryEntries(
    entries: RegistryEntry[],
    visibleFromPath?: string,
  ): RegistryEntry[] {
    if (!visibleFromPath) return entries;
    // All explicitly-configured registries (base + custom) are always visible.
    // Visibility scoping only applies to future auto-discovered registries.
    return entries;
  }

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

  private pathContains(parent: string, child: string): boolean {
    const parentPath = resolve(parent);
    const childPath = resolve(child);
    const childRelativePath = relative(parentPath, childPath);
    return (
      childRelativePath === "" ||
      (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
    );
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
        throw new RigError("TOOL_INVALID", `Tool ${child.name} has multiple Rig entry files.`, {
          toolDir,
          found: toolPaths,
          expected: RigToolEntryFiles,
        });
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
    throw new RigError("TOOL_INVALID", `Tool ${toolName} must use index.rig.ts or index.rig.tsx.`, {
      toolDir,
      found: legacyPath,
      expected: RigToolEntryFiles,
    });
  }
}
