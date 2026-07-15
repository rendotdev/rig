import { readFile } from "node:fs/promises";
import type { ConfigOptions } from "../../config/config";
import { DomainClass } from "../../domain/domain-class";
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

export class ToolApiMigrationServiceClass extends DomainClass<
  ConfigOptions,
  ToolApiMigrationServiceDeps
> {
  private readonly discovery: ToolDiscoveryServiceClass;
  private readonly readSource: (path: string) => Promise<string>;

  public constructor(params: ConfigOptions, deps: ToolApiMigrationServiceDeps) {
    super(params, deps);
    this.discovery = this.deps.discovery ?? new ToolDiscoveryServiceClass(this.params);
    this.readSource =
      this.deps.readSource ??
      ((path) => (typeof Bun !== "undefined" ? Bun.file(path).text() : readFile(path, "utf8")));
  }

  public async inspect(params: { visibleFromPath?: string } = {}): Promise<ToolApiMigrationReport> {
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
    if (params.report.ready) return "";

    const lines = ["### Rig tool migration required", ""];
    if (params.report.migrations.length > 0) {
      lines.push(
        `Migrate these tools to Rig tool API v${params.report.currentVersion}:`,
        "",
        ...params.report.migrations.map(
          (entry) =>
            `- ${entry.name}: v${entry.fromVersion} to v${entry.toVersion} (${entry.path})`,
        ),
        "",
        "For each tool:",
        "",
        "1. Export the factory directly as `(rig: RigToolKit) => rig.defineTool({ ... })`.",
        "2. Remove the redundant `name`; Rig derives it from the folder.",
        "3. Define `commands` as `(command) => ({ ... })` and replace each `rig.defineCommand({ ... })` with `command({ ... })`.",
        `4. Set the header to \`// rig:tool-api-version ${params.report.currentVersion}\`.`,
        "5. Run `rig typecheck <tool>` and execute the command examples before considering the migration complete.",
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

  public renderCli(params: { report: ToolApiMigrationReport }): string {
    if (params.report.ready) {
      return `All tools use Rig tool API v${params.report.currentVersion}.`;
    }
    return this.renderAgentInstructions(params).replace(/^### /, "");
  }

  private async inspectTool(params: { tool: DiscoveredTool }): Promise<ToolApiMigrationEntry> {
    const source = await this.readSource(params.tool.toolPath);
    return {
      name: params.tool.name,
      path: params.tool.toolPath,
      fromVersion: this.sourceVersion({ source }),
      toVersion: CurrentRigToolApiVersion,
    };
  }

  private sourceVersion(params: { source: string }): number {
    const match = /^\/\/ rig:tool-api-version (\d+)\s*$/m.exec(params.source);
    if (!match) return 1;
    const version = Number.parseInt(match[1]!, 10);
    return Number.isSafeInteger(version) && version > 0 ? version : 1;
  }
}
