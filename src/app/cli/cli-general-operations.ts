import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  RigConfigStoreService,
  rigConfigStoreLayer,
} from "../../domains/settings/service/config-store";
import {
  RigPathsConfigService,
  rigPathsConfigLayer,
  rigPathsLayer,
} from "../../providers/paths/rig-paths";
import type { RigDirectoryMigrationResult } from "../../domains/settings/types/directory-migration";
import {
  AgentInstructionSyncService,
  agentInstructionSyncLayer,
} from "../../domains/tools/runtime/agent-instruction-sync";
import {
  ToolRuntimeInstructionSyncService,
  toolRuntimeInstructionSyncLayer,
} from "../../domains/tools/runtime/tool-runtime-instruction-sync";
import { RuntimeSupportService } from "../../domains/tools/runtime/runtime-support";
import { RigError } from "../../providers/errors/rig-error";
import { RegistryService, registryLayer } from "../../domains/registry/service/registry";
import {
  ToolDiscoveryService,
  toolDiscoveryLayer,
} from "../../domains/registry/service/tool-discovery";
import { RigLoggerService, rigLoggerLayer } from "../../providers/logging/rig-logger";
import { NpmUpdateCheckService } from "../../domains/updates/service/npm-update-check";
import { npmUpdateCheckLayer } from "../../domains/updates/runtime/npm-update-check";
import { ToolApiMigrationService } from "../../domains/tools/runtime/tool-api-migration";
import { HelpTopicsService, helpTopicsLayer } from "../../domains/tools/service/help-topics";
import { ToolHelpService } from "../../domains/tools/runtime/tool-help";
import { toolServicesLayer } from "../../domains/tools/runtime/tool-services-layer";
import { CliEnvironmentConfigService, CliPlatformService, cliPlatformLayer } from "./cli-platform";
import { CliVersionService, cliVersionLayer } from "./cli-version";

class CliHelpOperationsService extends Context.Service<
  CliHelpOperationsService,
  { readonly help: (target: string | undefined, fallback: string) => Effect.Effect<void, unknown> }
>()("@rendotdev/rig/application/CliHelpOperationsService", {
  make: Effect.gen(function* () {
    const topics = yield* HelpTopicsService;
    const toolHelp = yield* ToolHelpService;
    const version = yield* CliVersionService;
    const platform = yield* CliPlatformService;
    const help = Effect.fn("CliHelpOperationsService.help")(function* (
      target: string | undefined,
      fallback: string,
    ) {
      if (!target) {
        const readmePath = join(yield* version.packageRoot, "README.md");
        yield* platform.log(
          (yield* platform.exists(readmePath)) ? yield* platform.readText(readmePath) : fallback,
        );
        return;
      }
      if (target === "topics") {
        yield* platform.log(yield* topics.renderList);
        return;
      }
      const topic = yield* topics.render(target);
      yield* platform.log(topic ?? (yield* toolHelp.render(target)));
    });
    return { help } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliHelpOperationsService, CliHelpOperationsService.make);
}

class CliStatusNoticeService extends Context.Service<
  CliStatusNoticeService,
  {
    readonly migration: (result: RigDirectoryMigrationResult | undefined) => Effect.Effect<void>;
    readonly notices: (currentVersion: string) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliStatusNoticeService", {
  make: Effect.gen(function* () {
    const updates = yield* NpmUpdateCheckService;
    const toolMigrations = yield* ToolApiMigrationService;
    const platform = yield* CliPlatformService;
    const migration = Effect.fn("CliStatusNoticeService.migration")(function* (
      result: RigDirectoryMigrationResult | undefined,
    ) {
      if (!result) return;
      if (result.status === "migrated") {
        yield* platform.log("Rig moved its home folder:");
        yield* platform.log(`  From: ${result.legacyDir}`);
        yield* platform.log(`  To:   ${result.currentDir}`);
        if (result.configUpdated) yield* platform.log("  Updated base registry: ~/rig/tools");
        yield* platform.log("");
        return;
      }
      yield* platform.log("Rig home folder migration needs your attention:");
      yield* platform.log(`  Old folder: ${result.legacyDir}`);
      yield* platform.log(`  New folder: ${result.currentDir}`);
      yield* platform.log(`  Reason: ${result.reason}`);
      yield* platform.log(
        "Move the files you want to keep into the new folder, then remove the old folder.",
      );
      yield* platform.log(
        "This migration prompt is versioned; Rig will not show it again after this run.",
      );
      yield* platform.log("");
    });
    const notices = Effect.fn("CliStatusNoticeService.notices")(function* (currentVersion: string) {
      const report = yield* toolMigrations.inspect();
      if (!report.ready) yield* platform.log(`\n${yield* toolMigrations.renderCli(report)}`);
      const notice = yield* updates
        .check(currentVersion)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (notice) yield* platform.log(`\n${notice.message}`);
    });
    return { migration, notices } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliStatusNoticeService, CliStatusNoticeService.make);
}

class CliStatusOperationsService extends Context.Service<
  CliStatusOperationsService,
  {
    readonly defaultStatus: Effect.Effect<void, unknown>;
    readonly doctor: Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliStatusOperationsService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const paths = yield* RigPathsConfigService;
    const registry = yield* RegistryService;
    const discovery = yield* ToolDiscoveryService;
    const logger = yield* RigLoggerService;
    const notices = yield* CliStatusNoticeService;
    const version = yield* CliVersionService;
    const platform = yield* CliPlatformService;
    const defaultStatus = Effect.gen(function* () {
      yield* config.ensure;
      const migrationResult = yield* config.migrationResult;
      yield* notices.migration(migrationResult);
      if (migrationResult?.status === "manual") yield* config.acknowledgeMigrationPrompt;
      const registries = yield* registry.list;
      const tools = yield* discovery.discover();
      const currentVersion = yield* version.current;
      const log = yield* logger.app("cli");
      yield* Effect.sync(() =>
        log.info({ version: currentVersion, tools: tools.length }, "Default status rendered."),
      );
      yield* platform.log("Rig is ready.\n");
      yield* platform.log(`Version:       ${currentVersion}`);
      yield* platform.log(`Config:        ${paths.configPath}`);
      yield* platform.log(`Base registry: ${registries.registries[0]?.path}`);
      const custom = registries.registries.filter((entry) => entry.kind === "custom");
      if (custom.length > 0) {
        yield* platform.log("Custom registries:");
        for (const entry of custom) yield* platform.log(`  ${entry.path}`);
      }
      yield* platform.log(`Tools found:   ${tools.length}`);
      yield* platform.log("\nNext steps:");
      yield* platform.log("  rig list");
      yield* platform.log('\nRun "rig doctor" if you want to verify your setup.');
      yield* notices.notices(currentVersion);
    }).pipe(Effect.withSpan("CliStatusOperationsService.defaultStatus"));
    const doctor = Effect.gen(function* () {
      yield* config.ensure;
      const migrationResult = yield* config.migrationResult;
      yield* notices.migration(migrationResult);
      if (migrationResult?.status === "manual") yield* config.acknowledgeMigrationPrompt;
      const registries = yield* registry.list;
      const tools = yield* discovery.discover();
      const log = yield* logger.app("doctor");
      yield* Effect.sync(() =>
        log.info(
          { registries: registries.registries.length, tools: tools.length },
          "Doctor check completed.",
        ),
      );
      yield* platform.log("Rig doctor\n");
      yield* platform.log(`Config:        OK ${paths.configPath}`);
      yield* platform.log(`Runtime SDK:   OK ${paths.runtimeSdkPath}`);
      yield* platform.log(`Registries:    ${registries.registries.length}`);
      for (const entry of registries.registries)
        yield* platform.log(`  ${entry.kind}: ${entry.path}`);
      yield* platform.log(`Tools:         ${tools.length}`);
      yield* platform.log("\nStatus: OK");
      yield* notices.notices(yield* version.current);
    }).pipe(Effect.withSpan("CliStatusOperationsService.doctor"));
    return { defaultStatus, doctor } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliStatusOperationsService, CliStatusOperationsService.make);
}

export class CliGeneratedSyncOperationsService extends Context.Service<
  CliGeneratedSyncOperationsService,
  { readonly sync: Effect.Effect<void, RigError> }
>()("@rendotdev/rig/application/CliGeneratedSyncOperationsService", {
  make: Effect.gen(function* () {
    const environment = yield* CliEnvironmentConfigService;
    const tools = yield* ToolRuntimeInstructionSyncService;
    const agents = yield* AgentInstructionSyncService;
    const runtime = yield* RuntimeSupportService;
    const registry = yield* RegistryService;
    const sync = Effect.gen(function* () {
      const state = yield* registry.list;
      yield* runtime.ensure(state.registries.map((entry) => entry.path));
      yield* tools.sync;
      if (environment.env.RIG_AGENT_SYNC !== "0") yield* agents.sync;
    }).pipe(Effect.withSpan("CliGeneratedSyncOperationsService.sync"));
    return { sync } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliGeneratedSyncOperationsService,
    CliGeneratedSyncOperationsService.make,
  );
}

export class CliGeneralOperationsService extends Context.Service<
  CliGeneralOperationsService,
  {
    readonly version: Effect.Effect<string>;
    readonly defaultStatus: Effect.Effect<void, unknown>;
    readonly doctor: Effect.Effect<void, unknown>;
    readonly help: (target: string | undefined, fallback: string) => Effect.Effect<void, unknown>;
    readonly showConfig: Effect.Effect<void, unknown>;
    readonly showConfigPath: Effect.Effect<void>;
    readonly listRegistries: Effect.Effect<void, unknown>;
    readonly addRegistry: (path?: string) => Effect.Effect<void, unknown>;
    readonly removeRegistry: (path: string) => Effect.Effect<void, unknown>;
    readonly syncGeneratedFiles: Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/application/CliGeneralOperationsService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const paths = yield* RigPathsConfigService;
    const registry = yield* RegistryService;
    const helpOperations = yield* CliHelpOperationsService;
    const status = yield* CliStatusOperationsService;
    const sync = yield* CliGeneratedSyncOperationsService;
    const versionService = yield* CliVersionService;
    const platform = yield* CliPlatformService;
    const version = versionService.current.pipe(
      Effect.withSpan("CliGeneralOperationsService.version"),
    );
    const defaultStatus = status.defaultStatus.pipe(
      Effect.withSpan("CliGeneralOperationsService.defaultStatus"),
    );
    const doctor = status.doctor.pipe(Effect.withSpan("CliGeneralOperationsService.doctor"));
    const help = Effect.fn("CliGeneralOperationsService.help")(function* (
      target: string | undefined,
      fallback: string,
    ) {
      yield* helpOperations.help(target, fallback);
    });
    const showConfig = config.ensure.pipe(
      Effect.flatMap(platform.printJson),
      Effect.withSpan("CliGeneralOperationsService.showConfig"),
    );
    const showConfigPath = platform
      .log(paths.configPath)
      .pipe(Effect.withSpan("CliGeneralOperationsService.showConfigPath"));
    const listRegistries = registry.list.pipe(
      Effect.flatMap(platform.printJson),
      Effect.withSpan("CliGeneralOperationsService.listRegistries"),
    );
    const addRegistry = Effect.fn("CliGeneralOperationsService.addRegistry")(function* (
      path?: string,
    ) {
      yield* platform.printJson(yield* registry.add(path ?? (yield* platform.cwd)));
    });
    const removeRegistry = Effect.fn("CliGeneralOperationsService.removeRegistry")(function* (
      path: string,
    ) {
      yield* platform.printJson(yield* registry.remove(path));
    });
    const syncGeneratedFiles = sync.sync.pipe(
      Effect.withSpan("CliGeneralOperationsService.syncGeneratedFiles"),
    );
    return {
      version,
      defaultStatus,
      doctor,
      help,
      showConfig,
      showConfigPath,
      listRegistries,
      addRegistry,
      removeRegistry,
      syncGeneratedFiles,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliGeneralOperationsService,
    CliGeneralOperationsService.make,
  );
}

const cliHelpOperationsLayer = CliHelpOperationsService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(helpTopicsLayer, toolServicesLayer, cliVersionLayer, cliPlatformLayer),
  ),
);
const cliStatusNoticeLayer = CliStatusNoticeService.layer.pipe(
  Layer.provide(Layer.mergeAll(npmUpdateCheckLayer, toolServicesLayer, cliPlatformLayer)),
);
const cliToolDiscoveryLayer = toolDiscoveryLayer.pipe(
  Layer.provide(Layer.merge(registryLayer, rigPathsLayer)),
);
const cliStatusOperationsLayer = CliStatusOperationsService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigConfigStoreLayer,
      rigPathsConfigLayer,
      registryLayer,
      cliToolDiscoveryLayer,
      rigLoggerLayer,
      cliStatusNoticeLayer,
      cliVersionLayer,
      cliPlatformLayer,
    ),
  ),
);
const cliGeneratedSyncOperationsLayer = CliGeneratedSyncOperationsService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      CliEnvironmentConfigService.layer,
      toolRuntimeInstructionSyncLayer,
      agentInstructionSyncLayer,
      registryLayer,
      toolServicesLayer,
    ),
  ),
);
export const cliGeneralOperationsLayer = CliGeneralOperationsService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigConfigStoreLayer,
      rigPathsConfigLayer,
      registryLayer,
      cliHelpOperationsLayer,
      cliStatusOperationsLayer,
      cliGeneratedSyncOperationsLayer,
      cliVersionLayer,
      cliPlatformLayer,
    ),
  ),
);
