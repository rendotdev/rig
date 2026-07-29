import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigAgentInstructions } from "../config/agent-instructions";
import { RigPathsConfigService, RigPathsService } from "../../../providers/paths/rig-paths";
import { RigToolEntryFiles } from "../../registry/types/tool-discovery";
import type { AgentInstructionTarget } from "../types/agent-instruction";

class AgentSourceFingerprintService extends Context.Service<
  AgentSourceFingerprintService,
  { readonly source: Effect.Effect<string | undefined> }
>()("@rendotdev/rig/generated/agent/AgentSourceFingerprintService", {
  make: Effect.gen(function* () {
    const pathConfig = yield* RigPathsConfigService;
    const paths = yield* RigPathsService;
    const directoryEntries = async (path: string): Promise<string[]> => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .toSorted();
      } catch {
        return [];
      }
    };
    const fingerprintHash = (values: Array<string | undefined>): string => {
      const digest = createHash("sha256");
      for (const value of values) digest.update(value ?? "").update("\0");
      return digest.digest("hex");
    };
    const source = Effect.gen(function* () {
      const configSource = yield* Effect.tryPromise({
        try: () => readFile(pathConfig.configPath, "utf8"),
        catch: () => undefined,
      });
      const config = yield* Effect.try({
        try: () =>
          JSON.parse(configSource) as {
            baseRegistryDir?: string;
            customRegistries?: string[];
          },
        catch: () => undefined,
      });
      const registryPaths = yield* Effect.all([
        paths.resolve(config.baseRegistryDir || pathConfig.defaultBaseRegistryDir),
        ...(config.customRegistries ?? []).map(paths.resolve),
      ]);
      const sources = yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            registryPaths.map(async (registryPath) => {
              const entries = await directoryEntries(registryPath);
              return Promise.all(
                entries.flatMap((entry) =>
                  RigToolEntryFiles.map(async (file) => {
                    const path = join(registryPath, entry, file);
                    try {
                      return `${path}\0${await readFile(path, "utf8")}`;
                    } catch {
                      return undefined;
                    }
                  }),
                ),
              );
            }),
          ),
        catch: () => undefined,
      });
      return fingerprintHash([
        RigAgentInstructions,
        configSource,
        ...sources.flat(2).filter(Boolean),
      ]);
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.withSpan("AgentSourceFingerprintService.source"),
    );
    return { source } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentSourceFingerprintService,
    AgentSourceFingerprintService.make,
  );
}

class AgentTargetFingerprintService extends Context.Service<
  AgentTargetFingerprintService,
  {
    readonly targets: (
      targets: AgentInstructionTarget[],
    ) => Effect.Effect<Record<string, string> | undefined>;
  }
>()("@rendotdev/rig/generated/agent/AgentTargetFingerprintService", {
  make: Effect.gen(function* () {
    const fingerprintHash = (values: Array<string | undefined>): string => {
      const digest = createHash("sha256");
      for (const value of values) digest.update(value ?? "").update("\0");
      return digest.digest("hex");
    };
    const targets = Effect.fn("AgentTargetFingerprintService.targets")(function* (
      instructionTargets: AgentInstructionTarget[],
    ) {
      return yield* Effect.tryPromise({
        try: async () =>
          Object.fromEntries(
            await Promise.all(
              instructionTargets.map(async (target) => [
                target.path,
                fingerprintHash([await readFile(target.path, "utf8")]),
              ]),
            ),
          ),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    });
    return { targets } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentTargetFingerprintService,
    AgentTargetFingerprintService.make,
  );
}

export class AgentSyncFingerprintService extends Context.Service<
  AgentSyncFingerprintService,
  {
    readonly source: Effect.Effect<string | undefined>;
    readonly targets: (
      targets: AgentInstructionTarget[],
    ) => Effect.Effect<Record<string, string> | undefined>;
  }
>()("@rendotdev/rig/generated/agent/AgentSyncFingerprintService", {
  make: Effect.gen(function* () {
    const sources = yield* AgentSourceFingerprintService;
    const targetFingerprints = yield* AgentTargetFingerprintService;
    const source = sources.source.pipe(Effect.withSpan("AgentSyncFingerprintService.source"));
    const targets = Effect.fn("AgentSyncFingerprintService.targets")(function* (
      instructionTargets: AgentInstructionTarget[],
    ) {
      return yield* targetFingerprints.targets(instructionTargets);
    });
    return { source, targets } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentSyncFingerprintService,
    AgentSyncFingerprintService.make,
  );
}

export const agentSyncFingerprintLayer = AgentSyncFingerprintService.layer.pipe(
  Layer.provide(
    Layer.merge(AgentSourceFingerprintService.layer, AgentTargetFingerprintService.layer),
  ),
);
