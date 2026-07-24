import { existsSync, lstatSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineService } from "../../define";
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

type ToolDiscoveryConfigStore = Pick<RigConfigStoreClass, "ensure" | "registryEntries">;
type ToolDiscoveryPaths = Pick<RigPathsClass, "resolve">;

type ToolDiscoveryServiceDeps = {
  createConfigStore: (options: ConfigOptions) => ToolDiscoveryConfigStore;
  createPaths: (options: ConfigOptions) => ToolDiscoveryPaths;
  exists: typeof existsSync;
  lstat: typeof lstatSync;
  stat: typeof statSync;
  readdir: typeof readdir;
  dirname: typeof dirname;
  join: typeof join;
};

function visibleRegistryEntries(params: {
  entries: RegistryEntry[];
  visibleFromPath?: string;
}): RegistryEntry[] {
  if (!params.visibleFromPath) return params.entries;
  return params.entries;
}

const ToolDiscoveryServiceProductionDeps: ToolDiscoveryServiceDeps = {
  createConfigStore(options) {
    return new RigConfigStoreClass(options);
  },
  createPaths(options) {
    return new RigPathsClass(options);
  },
  exists: existsSync,
  lstat: lstatSync,
  stat: statSync,
  readdir,
  dirname,
  join,
};

export class ToolDiscoveryService extends defineService({
  params: {} as ConfigOptions,
  deps: ToolDiscoveryServiceProductionDeps,
}) {
  private readonly configStore = this.deps.createConfigStore(this.params);
  private readonly paths = this.deps.createPaths(this.params);

  /* v8 ignore start */
  private visibilityStartDirectory(params: { pathValue: string }): string {
    const absolute = this.paths.resolve(params.pathValue);
    try {
      const pathStat = this.deps.stat(absolute);
      if (pathStat.isDirectory()) return absolute;
    } catch {
      // Missing instruction files still scope to their parent directory.
    }
    return this.deps.dirname(absolute);
  }

  public projectRootFor(params: { pathValue: string }): string {
    let current = this.visibilityStartDirectory(params);
    let packageRoot: string | undefined;
    while (true) {
      if (this.deps.exists(this.deps.join(current, ".git"))) return current;
      if (!packageRoot && this.deps.exists(this.deps.join(current, "package.json"))) {
        packageRoot = current;
      }
      const parent = this.deps.dirname(current);
      if (parent === current) return packageRoot ?? this.visibilityStartDirectory(params);
      current = parent;
    }
  }
  /* v8 ignore stop */

  private rejectLegacyEntry(params: { toolName: string; toolDir: string }): void {
    const legacyPath = this.deps.join(params.toolDir, "tool.ts");
    if (!this.deps.exists(legacyPath)) return;
    throw new RigErrorClass(
      "TOOL_INVALID",
      `Tool ${params.toolName} must use index.rig.ts or index.rig.tsx.`,
      { toolDir: params.toolDir, found: legacyPath, expected: RigToolEntryFiles },
    );
  }

  private discoverNamedTool(params: {
    entry: RegistryEntry;
    name: string;
  }): DiscoveredTool | undefined {
    const toolDir = this.deps.join(params.entry.path, params.name);
    try {
      if (!this.deps.lstat(toolDir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const toolPaths = RigToolEntryFiles.map((file) => this.deps.join(toolDir, file)).filter(
      (path) => this.deps.exists(path),
    );
    if (toolPaths.length > 1) {
      throw new RigErrorClass("TOOL_INVALID", `Tool ${params.name} has multiple Rig entry files.`, {
        toolDir,
        found: toolPaths,
        expected: RigToolEntryFiles,
      });
    }
    if (toolPaths.length === 0) {
      this.rejectLegacyEntry({ toolName: params.name, toolDir });
      return undefined;
    }
    return {
      name: params.name,
      registryKind: params.entry.kind,
      registryPath: params.entry.path,
      toolDir,
      toolPath: toolPaths[0]!,
    };
  }

  public async discoverRegistry(params: { entry: RegistryEntry }): Promise<DiscoveredTool[]> {
    if (!this.deps.exists(params.entry.path)) return [];
    const children = await this.deps.readdir(params.entry.path, { withFileTypes: true });
    return children.flatMap((child) => {
      if (!child.isDirectory()) return [];
      const toolDir = this.deps.join(params.entry.path, child.name);
      const toolPaths = RigToolEntryFiles.map((file) => this.deps.join(toolDir, file)).filter(
        (path) => this.deps.exists(path),
      );
      if (toolPaths.length > 1) {
        throw new RigErrorClass(
          "TOOL_INVALID",
          `Tool ${child.name} has multiple Rig entry files.`,
          { toolDir, found: toolPaths, expected: RigToolEntryFiles },
        );
      }
      if (toolPaths.length === 0) {
        this.rejectLegacyEntry({ toolName: child.name, toolDir });
        return [];
      }
      return [
        {
          name: child.name,
          registryKind: params.entry.kind,
          registryPath: params.entry.path,
          toolDir,
          toolPath: toolPaths[0]!,
        },
      ];
    });
  }

  public async discover(params: ToolDiscoveryOptions = {}): Promise<DiscoveredTool[]> {
    const rigConfig = await this.configStore.ensure();
    const entries = visibleRegistryEntries({
      entries: this.configStore.registryEntries(rigConfig),
      visibleFromPath: params.visibleFromPath,
    });
    const discoveredByRegistry = await Promise.all(
      entries.map((entry) => this.discoverRegistry({ entry })),
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
    return [...tools.values()].toSorted((left, right) => left.name.localeCompare(right.name));
  }

  public async find(params: { name: string }): Promise<DiscoveredTool> {
    if (!/^[A-Za-z0-9_-]+$/.test(params.name)) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${params.name}`, {
        name: params.name,
      });
    }
    const rigConfig = await this.configStore.ensure();
    const discovered = this.configStore
      .registryEntries(rigConfig)
      .map((entry) => this.discoverNamedTool({ entry, name: params.name }))
      .filter((tool): tool is DiscoveredTool => tool !== undefined);
    if (discovered.length > 1) {
      throw new RigErrorClass("DUPLICATE_TOOL", `Duplicate tool name: ${params.name}`, {
        name: params.name,
        paths: discovered.map((tool) => tool.toolPath),
      });
    }
    const tool = discovered[0];
    if (!tool) {
      throw new RigErrorClass("TOOL_NOT_FOUND", `Tool not found: ${params.name}`, {
        name: params.name,
      });
    }
    return tool;
  }
}

export type ToolDiscoveryServiceClass = {
  discover(options?: ToolDiscoveryOptions): Promise<DiscoveredTool[]>;
  find(name: string): Promise<DiscoveredTool>;
  projectRootFor(pathValue: string): string;
};

type ToolDiscoveryServiceConstructor = {
  new (options?: ConfigOptions): ToolDiscoveryServiceClass;
  readonly prototype: ToolDiscoveryServiceClass;
};

type ToolDiscoveryServiceAdapter = ToolDiscoveryServiceClass & {
  readonly resource: ToolDiscoveryService;
  discoverRegistry(entry: RegistryEntry): Promise<DiscoveredTool[]>;
};

const ToolDiscoveryServiceClassAdapter = function constructToolDiscoveryService(
  this: ToolDiscoveryServiceAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolDiscoveryService({
      params: options,
      deps: ToolDiscoveryServiceProductionDeps,
    }),
  });
};
Object.defineProperty(ToolDiscoveryServiceClassAdapter, "name", {
  value: "ToolDiscoveryServiceClass",
});
Object.defineProperties(ToolDiscoveryServiceClassAdapter.prototype, {
  discover: {
    configurable: true,
    value: function discover(
      this: ToolDiscoveryServiceAdapter,
      options: ToolDiscoveryOptions = {},
    ) {
      return this.resource.discover(options);
    },
    writable: true,
  },
  find: {
    configurable: true,
    value: function find(this: ToolDiscoveryServiceAdapter, name: string) {
      return this.resource.find({ name });
    },
    writable: true,
  },
  projectRootFor: {
    configurable: true,
    value: function projectRootFor(this: ToolDiscoveryServiceAdapter, pathValue: string) {
      return this.resource.projectRootFor({ pathValue });
    },
    writable: true,
  },
  discoverRegistry: {
    configurable: true,
    value: function discoverRegistry(this: ToolDiscoveryServiceAdapter, entry: RegistryEntry) {
      return this.resource.discoverRegistry({ entry });
    },
    writable: true,
  },
});

export const ToolDiscoveryServiceClass =
  ToolDiscoveryServiceClassAdapter as unknown as ToolDiscoveryServiceConstructor;
