import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RigConfigStore, type ConfigOptions, type RegistryEntry } from "../config/config";
import { RigError } from "../errors/RigError";

export type RegistryKind = "base" | "custom";

export const RigToolEntryFiles = ["index.rig.ts", "index.rig.tsx"] as const;

export type DiscoveredTool = {
  name: string;
  registryKind: RegistryKind;
  registryPath: string;
  toolDir: string;
  toolPath: string;
};

export class ToolDiscoveryService {
  private readonly configStore: RigConfigStore;

  constructor(options: ConfigOptions = {}) {
    this.configStore = new RigConfigStore(options);
  }

  async discover(): Promise<DiscoveredTool[]> {
    const config = await this.configStore.ensure();
    const entries = this.configStore.registryEntries(config);
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
