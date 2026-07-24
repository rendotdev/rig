import { readFile } from "node:fs/promises";
import { defineService } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { ToolDiscoveryServiceClass, type DiscoveredTool } from "../../registry/discover";
import { CurrentRigToolApiVersion } from "../domain/tool-api";

export type ToolApiMigrationEntry = {
  name: string;
  path: string;
  fromVersion: number;
  toVersion: number;
};

export type ToolApiMigrationReport = {
  currentVersion: number;
  ready: boolean;
  migrations: ToolApiMigrationEntry[];
  unsupported: ToolApiMigrationEntry[];
};

export type ToolApiMigrationServiceDeps = {
  discovery?: ToolDiscoveryServiceClass;
  readSource?: (path: string) => Promise<string>;
};

type ToolApiMigrationDeps = {
  createDiscovery: (params: { options: ConfigOptions }) => ToolDiscoveryServiceClass;
  readSource: (params: { path: string }) => Promise<string>;
};

/* v8 ignore next 4 -- Bun path is covered by distribution integration */
async function readToolSource(params: { path: string }): Promise<string> {
  return typeof Bun !== "undefined"
    ? await Bun.file(params.path).text()
    : await readFile(params.path, "utf8");
}

const ToolApiMigrationProductionDeps: ToolApiMigrationDeps = {
  createDiscovery: function createDiscovery(params: { options: ConfigOptions }) {
    return new ToolDiscoveryServiceClass(params.options);
  },
  readSource: readToolSource,
};

function sourceVersion(params: { source: string }): number {
  const match = /^\/\/ rig:tool-api-version (\d+)\s*$/m.exec(params.source);
  if (!match) return 1;
  const version = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function renderToolApiAgentInstructions(params: { report: ToolApiMigrationReport }): string {
  if (params.report.ready) return "";

  const lines = ["### Rig tool migration required", ""];
  if (params.report.migrations.length > 0) {
    lines.push(
      `Migrate these tools to Rig tool API v${params.report.currentVersion}:`,
      "",
      ...params.report.migrations.map(
        (entry) => `- ${entry.name}: v${entry.fromVersion} to v${entry.toVersion} (${entry.path})`,
      ),
      "",
      "For each tool:",
      "",
      "1. Export the factory directly as `(rig: RigToolKit) => rig.defineTool({ ... })`.",
      "2. Remove the redundant `name`; Rig derives it from the folder.",
      "3. Define `commands` as `(command) => ({ ... })` and replace each inline `rig.defineCommand({ ... })` with `command({ ... })`.",
      "4. Move predeclared commands into the `commands` callback. Declare reusable command factories inside the callback or pass `command` into them.",
      `5. Set the header to \`// rig:tool-api-version ${params.report.currentVersion}\`.`,
      "6. Run `rig typecheck <tool>` and execute the command examples before considering the migration complete.",
    );
  }

  if (params.report.unsupported.length > 0) {
    lines.push(
      "",
      "These tools declare a newer API than this Rig installation supports:",
      "",
      ...params.report.unsupported.map(
        (entry) => `- ${entry.name}: v${entry.fromVersion} (${entry.path})`,
      ),
      "",
      "Update Rig before editing or running these tools.",
    );
  }

  return lines.join("\n");
}

function renderToolApiCli(params: { report: ToolApiMigrationReport }): string {
  if (params.report.ready) {
    return `All tools use Rig tool API v${params.report.currentVersion}.`;
  }
  return renderToolApiAgentInstructions(params).replace(/^### /, "");
}

export class ToolApiMigrationService extends defineService({
  params: {} as ConfigOptions,
  deps: ToolApiMigrationProductionDeps,
}) {
  private get discovery() {
    return this.deps.createDiscovery({ options: this.params });
  }

  private async inspectTool(params: { tool: DiscoveredTool }): Promise<ToolApiMigrationEntry> {
    const source = await this.deps.readSource({ path: params.tool.toolPath });
    return {
      name: params.tool.name,
      path: params.tool.toolPath,
      fromVersion: sourceVersion({ source }),
      toVersion: CurrentRigToolApiVersion,
    };
  }

  public async inspect(params: { visibleFromPath?: string }): Promise<ToolApiMigrationReport> {
    const tools = await this.discovery.discover(params);
    const entries = await Promise.all(tools.map((tool) => this.inspectTool({ tool })));
    const migrations = entries.filter((entry) => entry.fromVersion < entry.toVersion);
    const unsupported = entries.filter((entry) => entry.fromVersion > entry.toVersion);
    return {
      currentVersion: CurrentRigToolApiVersion,
      ready: migrations.length === 0 && unsupported.length === 0,
      migrations,
      unsupported,
    };
  }

  public renderAgentInstructions(params: { report: ToolApiMigrationReport }): string {
    return renderToolApiAgentInstructions(params);
  }

  public renderCli(params: { report: ToolApiMigrationReport }): string {
    return renderToolApiCli(params);
  }
}

export const ToolApiMigration = new ToolApiMigrationService();

export type ToolApiMigrationServiceClass = {
  inspect(params?: { visibleFromPath?: string }): Promise<ToolApiMigrationReport>;
  renderAgentInstructions(params: { report: ToolApiMigrationReport }): string;
  renderCli(params: { report: ToolApiMigrationReport }): string;
};

type ToolApiMigrationServiceConstructor = {
  new (params: ConfigOptions, deps: ToolApiMigrationServiceDeps): ToolApiMigrationServiceClass;
  readonly prototype: ToolApiMigrationServiceClass;
};

type ToolApiMigrationAdapter = ToolApiMigrationServiceClass & {
  readonly resource: ToolApiMigrationService;
};

const ToolApiMigrationServiceClassAdapter = function constructToolApiMigration(
  this: ToolApiMigrationAdapter,
  params: ConfigOptions,
  deps: ToolApiMigrationServiceDeps,
): void {
  const resource = new ToolApiMigrationService({
    params,
    deps: {
      createDiscovery: function createDiscovery() {
        return deps.discovery ?? new ToolDiscoveryServiceClass(params);
      },
      readSource: deps.readSource
        ? function readSource(readParams: { path: string }) {
            return deps.readSource!(readParams.path);
          }
        : readToolSource,
    },
  });
  Object.defineProperty(this, "resource", { value: resource });
};
Object.defineProperty(ToolApiMigrationServiceClassAdapter, "name", {
  value: "ToolApiMigrationServiceClass",
});
Object.defineProperties(ToolApiMigrationServiceClassAdapter.prototype, {
  inspect: {
    configurable: true,
    value: function inspect(
      this: ToolApiMigrationAdapter,
      params: { visibleFromPath?: string } = {},
    ) {
      return this.resource.inspect(params);
    },
    writable: true,
  },
  renderAgentInstructions: {
    configurable: true,
    value: function renderAgentInstructions(
      this: ToolApiMigrationAdapter,
      params: { report: ToolApiMigrationReport },
    ) {
      return this.resource.renderAgentInstructions(params);
    },
    writable: true,
  },
  renderCli: {
    configurable: true,
    value: function renderCli(
      this: ToolApiMigrationAdapter,
      params: { report: ToolApiMigrationReport },
    ) {
      return this.resource.renderCli(params);
    },
    writable: true,
  },
});

export const ToolApiMigrationServiceClass =
  ToolApiMigrationServiceClassAdapter as unknown as ToolApiMigrationServiceConstructor;
