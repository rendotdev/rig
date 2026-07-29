import { readFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import { CurrentRigToolApiVersion } from "../config/tool-api";

type ToolApiMigrationEntry = {
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

class ToolApiMigrationSourceService extends Context.Service<
  ToolApiMigrationSourceService,
  { readonly read: (path: string) => Effect.Effect<string, RigError> }
>()("@rendotdev/rig/tools/migration/ToolApiMigrationSourceService", {
  make: Effect.gen(function* () {
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const read = Effect.fn("ToolApiMigrationSourceService.read")(function* (path: string) {
      return yield* Effect.tryPromise({
        /* v8 ignore next 4 -- Bun path is covered by distribution integration */
        try: () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? Bun.file(path).text()
            : readFile(path, "utf8"),
        catch: toError,
      });
    });
    return { read } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolApiMigrationSourceService,
    ToolApiMigrationSourceService.make,
  );
}

export class ToolApiMigrationService extends Context.Service<
  ToolApiMigrationService,
  {
    readonly inspect: (options?: {
      visibleFromPath?: string;
    }) => Effect.Effect<ToolApiMigrationReport, RigError>;
    readonly renderAgentInstructions: (report: ToolApiMigrationReport) => Effect.Effect<string>;
    readonly renderCli: (report: ToolApiMigrationReport) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/tools/migration/ToolApiMigrationService", {
  make: Effect.gen(function* () {
    const discovery = yield* ToolDiscoveryService;
    const source = yield* ToolApiMigrationSourceService;
    const sourceVersion = (contents: string): number => {
      const match = /^\/\/ rig:tool-api-version (\d+)\s*$/m.exec(contents);
      if (!match) return 1;
      const version = Number.parseInt(match[1]!, 10);
      return Number.isSafeInteger(version) && version > 0 ? version : 1;
    };
    const renderAgentInstructions = Effect.fn("ToolApiMigrationService.renderAgentInstructions")(
      function* (report: ToolApiMigrationReport) {
        if (report.ready) return "";
        const lines = ["### Rig tool migration required", ""];
        if (report.migrations.length > 0) {
          lines.push(
            `Migrate these tools to Rig tool API v${report.currentVersion}:`,
            "",
            ...report.migrations.map(
              (entry) =>
                `- ${entry.name}: v${entry.fromVersion} to v${entry.toVersion} (${entry.path})`,
            ),
            "",
            "For each tool:",
            "",
            "1. Export the factory directly as `(rig: RigToolKit) => rig.defineTool({ ... })`.",
            "2. Remove the redundant `name`; Rig derives it from the folder.",
            "3. Define `commands` as `(command) => ({ ... })` and replace each inline `rig.defineCommand({ ... })` with `command({ ... })`.",
            "4. Move predeclared commands into the `commands` callback. Declare reusable command factories inside the callback or pass `command` into them.",
            `5. Set the header to \`// rig:tool-api-version ${report.currentVersion}\`.`,
            "6. Run `rig typecheck <tool>` and execute the command examples before considering the migration complete.",
          );
        }
        if (report.unsupported.length > 0) {
          lines.push(
            "",
            "These tools declare a newer API than this Rig installation supports:",
            "",
            ...report.unsupported.map(
              (entry) => `- ${entry.name}: v${entry.fromVersion} (${entry.path})`,
            ),
            "",
            "Update Rig before editing or running these tools.",
          );
        }
        return lines.join("\n");
      },
    );
    const renderCli = Effect.fn("ToolApiMigrationService.renderCli")(function* (
      report: ToolApiMigrationReport,
    ) {
      if (report.ready) return `All tools use Rig tool API v${report.currentVersion}.`;
      return (yield* renderAgentInstructions(report)).replace(/^### /, "");
    });
    const inspectTool = Effect.fn("ToolApiMigrationService.inspectTool")(function* (
      tool: DiscoveredTool,
    ) {
      const contents = yield* source.read(tool.toolPath);
      return {
        name: tool.name,
        path: tool.toolPath,
        fromVersion: sourceVersion(contents),
        toVersion: CurrentRigToolApiVersion,
      };
    });
    const inspect = Effect.fn("ToolApiMigrationService.inspect")(function* (
      options: { visibleFromPath?: string } = {},
    ) {
      const tools = yield* discovery.discover(options);
      const entries = yield* Effect.all(tools.map(inspectTool), { concurrency: "unbounded" });
      const migrations = entries.filter((entry) => entry.fromVersion < entry.toVersion);
      const unsupported = entries.filter((entry) => entry.fromVersion > entry.toVersion);
      return {
        currentVersion: CurrentRigToolApiVersion,
        ready: migrations.length === 0 && unsupported.length === 0,
        migrations,
        unsupported,
      };
    });
    return { inspect, renderAgentInstructions, renderCli } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolApiMigrationService, ToolApiMigrationService.make);
}

export const toolApiMigrationLayer = ToolApiMigrationService.layer.pipe(
  Layer.provide(ToolApiMigrationSourceService.layer),
);
