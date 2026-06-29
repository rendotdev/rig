import type { ConfigOptions } from "../config/config";
import { ToolDiscoveryService } from "../registry/discover";
import { ToolLoader } from "./loader";
import { CommandIds } from "./types";

export class ToolListService {
  private readonly discovery: ToolDiscoveryService;
  private readonly loader: ToolLoader;

  constructor(options: ConfigOptions = {}) {
    this.discovery = new ToolDiscoveryService(options);
    this.loader = new ToolLoader(options);
  }

  async list() {
    const discovered = await this.discovery.discover();
    const tools = await Promise.all(
      discovered.map(async (entry) => {
        const loaded = await this.loader.loadDiscovered(entry);
        const commands = Object.entries(loaded.definition.commands).map(([name, command]) => ({
          name,
          id: CommandIds.from(loaded.definition.name, name),
          description: command.description,
        }));
        return {
          name: loaded.definition.name,
          description: loaded.definition.description,
          registryKind: entry.registryKind,
          registryPath: entry.registryPath,
          toolPath: entry.toolPath,
          commands,
        };
      }),
    );

    return { tools };
  }

  renderPlain(data: Awaited<ReturnType<ToolListService["list"]>>): string {
    if (data.tools.length === 0) return "No tools found.";
    return data.tools
      .flatMap((tool) => tool.commands.map((command) => `${command.id} ${command.description}`))
      .join("\n");
  }
}
