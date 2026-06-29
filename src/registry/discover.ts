import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RigConfigStore, type ConfigOptions, type RegistryEntry } from "../config/config";
import { RigError } from "../errors/RigError";

export type RegistryKind = "base" | "custom";

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
      const toolPath = join(toolDir, "tool.ts");
      if (!existsSync(toolPath)) return [];
      return [
        {
          name: child.name,
          registryKind: entry.kind,
          registryPath: entry.path,
          toolDir,
          toolPath,
        },
      ];
    });
  }
}
