import { join } from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { RigAgentInstructions } from "../config/agent-instructions";
import { atomicFileWriterLayer } from "../../../providers/filesystem/atomic-file-writer";
import {
  RigPathsConfigService,
  RigPathsService,
  rigPathsConfigLayer,
  rigPathsLayer,
} from "../../../providers/paths/rig-paths";
import { runtimeSupportRendererLayer } from "./runtime-support";
import { RigError } from "../../../providers/errors/rig-error";
import { registryLayer } from "../../registry/service/registry";
import { toolDiscoveryLayer } from "../../registry/service/tool-discovery";
import { rigShellLayer } from "../../../providers/process/rig-shell-service";
import { toolIdentifierLayer } from "../service/tool-identifier";
import { schemaRendererLayer } from "../service/schema-renderer";
import { toolDefinitionLayer } from "../service/tool-definition";
import { toolEnvironmentLayer } from "./tool-environment";
import { toolLoaderLayer } from "./tool-loader";
import { ToolApiMigrationService, toolApiMigrationLayer } from "./tool-api-migration";
import { ToolListService, toolListLayer, toolMetadataCacheLayer } from "./tool-list";
import { rigToolKitLayer } from "./tool-sdk";
import {
  AgentInstructionDocumentsService,
  agentInstructionDocumentsLayer,
} from "../service/agent-instruction-documents";
import {
  AgentInstructionEndMarker,
  AgentInstructionStartMarker,
  type AgentInstructionSyncResult,
  type AgentInstructionTarget,
} from "../types/agent-instruction";
import {
  AgentInstructionTargetsConfigService,
  AgentInstructionTargetsService,
  agentInstructionTargetsLayer,
} from "./agent-instruction-targets";
import {
  AgentSyncFingerprintService,
  agentSyncFingerprintLayer,
} from "../service/agent-sync-fingerprint";

type AgentSyncStamp = {
  sourceFingerprint: string;
  targetFingerprints: Record<string, string>;
};

class AgentInstructionSyncStateService extends Context.Service<
  AgentInstructionSyncStateService,
  {
    readonly canSkip: (targets: AgentInstructionTarget[]) => Effect.Effect<boolean>;
    readonly projectHasRegistry: Effect.Effect<boolean, RigError>;
    readonly writeStamp: (targets: AgentInstructionTarget[]) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionSyncStateService", {
  make: Effect.gen(function* () {
    const documents = yield* AgentInstructionDocumentsService;
    const targets = yield* AgentInstructionTargetsService;
    const fingerprints = yield* AgentSyncFingerprintService;
    const pathConfig = yield* RigPathsConfigService;
    const paths = yield* RigPathsService;
    const syncStampPath = join(pathConfig.rigDir, ".agent-sync-stamp");
    const canSkip = Effect.fn("AgentInstructionSyncStateService.canSkip")(function* (
      instructionTargets: AgentInstructionTarget[],
    ) {
      return yield* Effect.gen(function* () {
        const stamp = JSON.parse(yield* documents.readText(syncStampPath)) as AgentSyncStamp;
        const [sourceFingerprint, targetFingerprints] = yield* Effect.all([
          fingerprints.source,
          fingerprints.targets(instructionTargets),
        ]);
        return Boolean(
          sourceFingerprint &&
          targetFingerprints &&
          stamp.sourceFingerprint === sourceFingerprint &&
          JSON.stringify(stamp.targetFingerprints) === JSON.stringify(targetFingerprints),
        );
      }).pipe(Effect.orElseSucceed(() => false));
    });
    const writeStamp = Effect.fn("AgentInstructionSyncStateService.writeStamp")(function* (
      instructionTargets: AgentInstructionTarget[],
    ) {
      yield* Effect.gen(function* () {
        const [sourceFingerprint, targetFingerprints] = yield* Effect.all([
          fingerprints.source,
          fingerprints.targets(instructionTargets.map((target) => ({ ...target, existed: true }))),
        ]);
        const hasIncompleteFingerprints = !sourceFingerprint || !targetFingerprints;
        if (hasIncompleteFingerprints) return;
        yield* documents.writeText(
          syncStampPath,
          `${JSON.stringify({ sourceFingerprint, targetFingerprints } satisfies AgentSyncStamp)}\n`,
        );
      }).pipe(Effect.ignore);
    });
    const projectHasRegistry = Effect.gen(function* () {
      const configSource = yield* documents.readText(pathConfig.configPath);
      const parsed = yield* Effect.try({
        try: () => JSON.parse(configSource) as unknown,
        catch: (cause) =>
          new RigError({
            code: "CONFIG_INVALID",
            message: `Config is not valid JSON at ${pathConfig.configPath}.`,
            details: { cause },
          }),
      });
      if (!Predicate.isObject(parsed)) return false;
      const root = yield* documents.safeRealPath(yield* targets.projectRoot);
      const custom = Array.isArray(parsed.customRegistries)
        ? parsed.customRegistries.filter((value): value is string => typeof value === "string")
        : [];
      const registries = yield* Effect.all([
        paths.resolve(
          typeof parsed.baseRegistryDir === "string"
            ? parsed.baseRegistryDir
            : pathConfig.defaultBaseRegistryDir,
        ),
        ...custom.map(paths.resolve),
      ]);
      const resolved = yield* Effect.all(registries.map(documents.safeRealPath));
      return resolved.some((path) => path === root || path.startsWith(`${root}/`));
    }).pipe(Effect.withSpan("AgentInstructionSyncStateService.projectHasRegistry"));
    return { canSkip, projectHasRegistry, writeStamp } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionSyncStateService,
    AgentInstructionSyncStateService.make,
  );
}

export class AgentInstructionSyncService extends Context.Service<
  AgentInstructionSyncService,
  {
    readonly sync: Effect.Effect<AgentInstructionSyncResult, RigError>;
    readonly discoverTargets: Effect.Effect<AgentInstructionTarget[]>;
    readonly renderBlock: (
      toolList: string,
      migrationInstructions?: string,
    ) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionSyncService", {
  make: Effect.gen(function* () {
    const documents = yield* AgentInstructionDocumentsService;
    const targets = yield* AgentInstructionTargetsService;
    const state = yield* AgentInstructionSyncStateService;
    const toolList = yield* ToolListService;
    const migrations = yield* ToolApiMigrationService;
    const renderBlock = Effect.fn("AgentInstructionSyncService.renderBlock")(function* (
      list: string,
      migrationInstructions = "",
    ) {
      return `${AgentInstructionStartMarker}

## Rig local tools

${RigAgentInstructions}${migrationInstructions ? `${migrationInstructions}\n\n` : ""}
### Available Rig tools

\`\`\`text
${list}
\`\`\`

${AgentInstructionEndMarker}`;
    });
    const discoverTargets = targets.discover.pipe(
      Effect.withSpan("AgentInstructionSyncService.discoverTargets"),
    );
    const sync = Effect.gen(function* () {
      if (process.env.RIG_AGENT_SYNC === "0") return { skipped: true, targets: [] };
      const instructionTargets = yield* targets.discover;
      if (instructionTargets.length === 0) return { skipped: false, targets: [] };
      if (yield* state.canSkip(instructionTargets)) {
        return {
          skipped: false,
          targets: instructionTargets.map((target) => ({ ...target, changed: false })),
        };
      }
      const migrationInstructions = yield* migrations.renderAgentInstructions(
        yield* migrations.inspect(),
      );
      const hasProjectRegistry = yield* state.projectHasRegistry;
      const updates = yield* Effect.all(
        instructionTargets.map((target) =>
          Effect.gen(function* () {
            const shouldRemoveInvisibleRegistryBlock =
              target.scope === "visible" && !hasProjectRegistry;
            if (shouldRemoveInvisibleRegistryBlock) {
              return { ...target, changed: yield* documents.removeManagedBlock(target) };
            }
            const data = yield* toolList.list(
              target.scope === "visible" ? { visibleFromPath: target.path } : {},
            );
            const block = yield* renderBlock(
              yield* toolList.renderPlain(data),
              migrationInstructions,
            );
            return { ...target, changed: yield* documents.upsertManagedBlock(target, block) };
          }),
        ),
        { concurrency: "unbounded" },
      );
      yield* state.writeStamp(instructionTargets);
      return { skipped: false, targets: updates };
    }).pipe(Effect.withSpan("AgentInstructionSyncService.sync"));
    return { sync, discoverTargets, renderBlock } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionSyncService,
    AgentInstructionSyncService.make,
  );
}

const runtimeRendererLayer = runtimeSupportRendererLayer.pipe(Layer.provide(rigPathsConfigLayer));
const registryForAgentLayer = registryLayer.pipe(
  Layer.provide(Layer.merge(atomicFileWriterLayer, runtimeRendererLayer)),
);
const discoveryForAgentLayer = toolDiscoveryLayer.pipe(
  Layer.provide(Layer.merge(registryForAgentLayer, rigPathsLayer)),
);
const toolkitForAgentLayer = rigToolKitLayer.pipe(
  Layer.provide(Layer.mergeAll(rigShellLayer, rigPathsConfigLayer, rigPathsLayer)),
);
const loaderForAgentLayer = toolLoaderLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      toolEnvironmentLayer,
      discoveryForAgentLayer,
      toolDefinitionLayer,
      toolIdentifierLayer,
      toolkitForAgentLayer,
    ),
  ),
);
const metadataForAgentLayer = toolMetadataCacheLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsConfigLayer,
      loaderForAgentLayer,
      atomicFileWriterLayer,
      schemaRendererLayer,
      toolIdentifierLayer,
    ),
  ),
);
const toolListForAgentLayer = toolListLayer.pipe(
  Layer.provide(Layer.mergeAll(discoveryForAgentLayer, metadataForAgentLayer, toolIdentifierLayer)),
);
const migrationForAgentLayer = toolApiMigrationLayer.pipe(Layer.provide(discoveryForAgentLayer));
const documentsForAgentLayer = agentInstructionDocumentsLayer.pipe(
  Layer.provide(atomicFileWriterLayer),
);
const targetsForAgentLayer = agentInstructionTargetsLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      documentsForAgentLayer,
      rigPathsConfigLayer,
      rigPathsLayer,
      AgentInstructionTargetsConfigService.layer,
    ),
  ),
);
const fingerprintsForAgentLayer = agentSyncFingerprintLayer.pipe(
  Layer.provide(Layer.merge(rigPathsConfigLayer, rigPathsLayer)),
);
const stateForAgentLayer = AgentInstructionSyncStateService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      documentsForAgentLayer,
      targetsForAgentLayer,
      fingerprintsForAgentLayer,
      rigPathsConfigLayer,
      rigPathsLayer,
    ),
  ),
);

export const agentInstructionSyncLayer = AgentInstructionSyncService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      documentsForAgentLayer,
      targetsForAgentLayer,
      stateForAgentLayer,
      toolListForAgentLayer,
      migrationForAgentLayer,
      rigPathsConfigLayer,
      rigPathsLayer,
    ),
  ),
);
