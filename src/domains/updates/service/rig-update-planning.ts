import { Context, Effect, Layer } from "effect";
import { PackageRootService, packageRootLayer } from "../../../providers/package/package-root";
import { RigUpdaterConfigService } from "../config/rig-updater-config";
import {
  RigUpdateCommandRunnerService,
  rigUpdateCommandRunnerLayer,
  RigUpdaterPlatformService,
  rigUpdaterRepositoryLayer,
} from "../repo/rig-updater-repository";
import {
  type RigInstallation,
  RigUpdateError,
  type RigUpdatePlan,
  type RigUpdateResult,
  type RigUpdateStep,
  type RunnableRigUpdatePlan,
} from "../types/updates";

class RigInstallationService extends Context.Service<
  RigInstallationService,
  { readonly resolve: (packageRoot: string) => Effect.Effect<RigInstallation> }
>()("@rendotdev/rig/updates/RigInstallationService", {
  make: Effect.gen(function* () {
    const platform = yield* RigUpdaterPlatformService;
    const resolve = Effect.fn("RigInstallationService.resolve")(function* (packageRoot: string) {
      const scopeDirectory = yield* platform.dirname(packageRoot);
      const nodeModulesDirectory = yield* platform.dirname(scopeDirectory);
      const hasUnsupportedPackageLayout =
        (yield* platform.basename(packageRoot)) !== "rig" ||
        (yield* platform.basename(scopeDirectory)) !== "@rendotdev" ||
        (yield* platform.basename(nodeModulesDirectory)) !== "node_modules";
      if (hasUnsupportedPackageLayout) {
        return { reason: "Rig is not running from a supported global npm or Bun installation." };
      }
      const parentDirectory = yield* platform.dirname(nodeModulesDirectory);
      if ((yield* platform.basename(parentDirectory)) === "lib") {
        const prefix = yield* platform.dirname(parentDirectory);
        return {
          kind: "npm" as const,
          packageManager: yield* platform.join([prefix, "bin", "npm"]),
          prefix,
          rig: yield* platform.join([prefix, "bin", "rig"]),
        };
      }
      const installDirectory = yield* platform.dirname(parentDirectory);
      const bunDirectory = yield* platform.dirname(installDirectory);
      const hasSupportedBunLayout =
        (yield* platform.basename(parentDirectory)) === "global" &&
        (yield* platform.basename(installDirectory)) === "install" &&
        (yield* platform.basename(bunDirectory)) === ".bun";
      if (hasSupportedBunLayout) {
        return {
          kind: "bun" as const,
          packageManager: yield* platform.join([bunDirectory, "bin", "bun"]),
          prefix: bunDirectory,
          rig: yield* platform.join([bunDirectory, "bin", "rig"]),
        };
      }
      return { reason: "Rig is not running from a supported global npm or Bun installation." };
    });
    return { resolve } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigInstallationService, RigInstallationService.make);
}

export class RigUpdatePlanningService extends Context.Service<
  RigUpdatePlanningService,
  { readonly plan: Effect.Effect<RigUpdatePlan, RigUpdateError> }
>()("@rendotdev/rig/updates/RigUpdatePlanningService", {
  make: Effect.gen(function* () {
    const config = yield* RigUpdaterConfigService;
    const platform = yield* RigUpdaterPlatformService;
    const commandRunner = yield* RigUpdateCommandRunnerService;
    const installations = yield* RigInstallationService;
    const packageRoot = yield* platform.resolve(config.params.packageRoot);
    const parseLatestVersion = (output: string): string => {
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        value = output.trim();
      }
      const isInvalidLatestVersion =
        typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim());
      if (isInvalidLatestVersion) {
        throw new Error("The package manager returned an invalid latest Rig version.");
      }
      return (value as string).trim();
    };
    const plan = Effect.gen(function* () {
      const installation = yield* installations.resolve(packageRoot);
      if ("reason" in installation) {
        return { status: "skipped" as const, reason: installation.reason };
      }
      if (!(yield* platform.executableExists(installation.packageManager))) {
        return {
          status: "skipped" as const,
          reason: `The package manager for this Rig installation was not found at ${installation.packageManager}.`,
        };
      }
      if (!(yield* platform.executableExists(installation.rig))) {
        return {
          status: "skipped" as const,
          reason: `The Rig executable for this installation was not found at ${installation.rig}.`,
        };
      }
      const output = yield* commandRunner.read({
        command: installation.packageManager,
        args:
          installation.kind === "npm"
            ? ["view", "@rendotdev/rig@latest", "version", "--json"]
            : ["pm", "view", "@rendotdev/rig@latest", "version"],
      });
      const latestVersion = yield* Effect.try({
        try: () => parseLatestVersion(output),
        catch: (cause) => new RigUpdateError({ operation: "plan", cause }),
      });
      const syncStep = {
        command: installation.rig,
        args: ["init"],
        env: { RIG_UPDATE_CHECK: "0" },
      };
      if (latestVersion === config.params.currentVersion) {
        return { status: "current" as const, version: config.params.currentVersion, syncStep };
      }
      return {
        status: "ready" as const,
        currentVersion: config.params.currentVersion,
        latestVersion,
        updateStep: {
          command: installation.packageManager,
          args:
            installation.kind === "npm"
              ? [
                  "install",
                  "--global",
                  "--prefix",
                  installation.prefix,
                  `@rendotdev/rig@${latestVersion}`,
                ]
              : ["install", "--global", `@rendotdev/rig@${latestVersion}`],
        },
        versionStep: { command: installation.rig, args: ["--version"] },
        syncStep,
      };
    }).pipe(Effect.withSpan("RigUpdatePlanningService.plan"));
    return { plan } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigUpdatePlanningService, RigUpdatePlanningService.make);
}

export class RigUpdateExecutionService extends Context.Service<
  RigUpdateExecutionService,
  {
    readonly update: (
      plan: Exclude<RigUpdatePlan, { status: "current" | "skipped" }>,
    ) => Effect.Effect<RigUpdateResult, RigUpdateError>;
    readonly sync: (
      plan: RunnableRigUpdatePlan,
    ) => Effect.Effect<{ step: RigUpdateStep; output: string }, RigUpdateError>;
  }
>()("@rendotdev/rig/updates/RigUpdateExecutionService", {
  make: Effect.gen(function* () {
    const commandRunner = yield* RigUpdateCommandRunnerService;
    const update = Effect.fn("RigUpdateExecutionService.update")(function* (
      updatePlan: Exclude<RigUpdatePlan, { status: "current" | "skipped" }>,
    ) {
      const output = yield* commandRunner.run(updatePlan.updateStep);
      const version = (yield* commandRunner.read(updatePlan.versionStep)).trim();
      if (version !== updatePlan.latestVersion) {
        return yield* new RigUpdateError({
          operation: "update",
          cause: new Error(
            `Rig reported version ${version || "unknown"} after updating to ${updatePlan.latestVersion}.`,
          ),
        });
      }
      return {
        status: "updated" as const,
        previousVersion: updatePlan.currentVersion,
        version,
        step: updatePlan.updateStep,
        output,
      };
    });
    const sync = Effect.fn("RigUpdateExecutionService.sync")(function* (
      updatePlan: RunnableRigUpdatePlan,
    ) {
      return {
        step: updatePlan.syncStep,
        output: yield* commandRunner.run(updatePlan.syncStep),
      };
    });
    return { update, sync } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigUpdateExecutionService, RigUpdateExecutionService.make);
}

export const rigUpdatePlanningLayer = RigUpdatePlanningService.layer.pipe(
  Layer.provide(RigInstallationService.layer),
);

const rigUpdaterConfigLayer = Layer.effect(
  RigUpdaterConfigService,
  Effect.gen(function* () {
    const packageTargets = yield* PackageRootService;
    const repository = yield* RigUpdaterPlatformService;
    const packageRoot = yield* packageTargets.find(import.meta.url);
    const packagePath = yield* packageTargets.packageFile(import.meta.url, "package.json");
    const currentVersion = yield* repository.readPackageVersion(packagePath);
    return { params: { packageRoot, currentVersion } } as const;
  }),
).pipe(Layer.provide(Layer.merge(packageRootLayer, rigUpdaterRepositoryLayer)));

const rigUpdatePlanningConfiguredLayer = rigUpdatePlanningLayer.pipe(
  Layer.provide(
    Layer.mergeAll(rigUpdaterConfigLayer, rigUpdaterRepositoryLayer, rigUpdateCommandRunnerLayer),
  ),
);

const rigUpdateExecutionLayer = RigUpdateExecutionService.layer.pipe(
  Layer.provide(rigUpdateCommandRunnerLayer),
);

export const rigUpdaterSupportLayer = Layer.mergeAll(
  rigUpdaterConfigLayer,
  rigUpdatePlanningConfiguredLayer,
  rigUpdateExecutionLayer,
);
