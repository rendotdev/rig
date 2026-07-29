import { Context, Effect, Layer, Schedule } from "effect";
import { NpmUpdateCheckConfigService } from "../config/npm-update-check-config";
import { npmRegistryLayer, NpmRegistryService } from "../repo/npm-registry";
import { npmUpdateCacheLayer, NpmUpdateCacheService } from "../repo/update-cache";
import {
  npmUpdateCheckPlatformLayer,
  NpmUpdateCheckPlatformService,
} from "../repo/update-check-platform";
import { NpmUpdateCheckError, type UpdateCheckNotice } from "../types/updates";

const REGISTRY_RETRY_DELAY = "25 millis";
const REGISTRY_RETRY_COUNT = 1;

export class NpmUpdateCheckService extends Context.Service<
  NpmUpdateCheckService,
  {
    readonly check: (
      currentVersion: string,
    ) => Effect.Effect<UpdateCheckNotice | undefined, NpmUpdateCheckError>;
  }
>()("@rendotdev/rig/updates/NpmUpdateCheckService", {
  make: Effect.gen(function* () {
    const config = yield* (yield* NpmUpdateCheckConfigService).get;
    const platform = yield* NpmUpdateCheckPlatformService;
    const registry = yield* NpmRegistryService;
    const cache = yield* NpmUpdateCacheService;
    const versionParts = (version: string): number[] =>
      version
        .replace(/^v/u, "")
        .split(/[.-]/u)
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part));
    const isNewerVersion = (candidate: string, current: string): boolean => {
      const candidateParts = versionParts(candidate);
      const currentParts = versionParts(current);
      const length = Math.max(candidateParts.length, currentParts.length);
      for (let index = 0; index < length; index += 1) {
        const candidatePart = candidateParts[index] ?? 0;
        const currentPart = currentParts[index] ?? 0;
        if (candidatePart > currentPart) return true;
        if (candidatePart < currentPart) return false;
      }
      return false;
    };
    const notice = (currentVersion: string, latestVersion?: string) =>
      !latestVersion || !isNewerVersion(latestVersion, currentVersion)
        ? undefined
        : {
            packageName: config.packageName,
            currentVersion,
            latestVersion,
            message: `Rig update available: ${config.packageName} ${currentVersion} -> ${latestVersion}. Run rig update.`,
          };
    const check = Effect.fn("NpmUpdateCheckService.check")(function* (currentVersion: string) {
      if ((yield* platform.environmentFlag("RIG_UPDATE_CHECK")) === "0") return undefined;
      const now = yield* platform.now;
      const cached = yield* cache
        .read(config.updateCheckCachePath)
        .pipe(Effect.orElseSucceed(() => undefined));
      const isCacheFresh = cached !== undefined && now - cached.checkedAt < config.cacheTtlMs;
      if (isCacheFresh) {
        return notice(currentVersion, cached.latestVersion);
      }
      const latestVersion = yield* registry
        .latestVersion(config.packageName, config.timeoutMs)
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential(REGISTRY_RETRY_DELAY).pipe(
              Schedule.upTo({ times: REGISTRY_RETRY_COUNT }),
            ),
          }),
          Effect.orElseSucceed(() => undefined),
        );
      if (!latestVersion) return undefined;
      yield* cache.write(config.updateCheckCachePath, {
        checkedAt: yield* platform.now,
        latestVersion,
      });
      return notice(currentVersion, latestVersion);
    });
    return { check } as const;
  }),
}) {
  static readonly layer = Layer.effect(NpmUpdateCheckService, NpmUpdateCheckService.make);
}

export const npmUpdateCheckServiceLayer = NpmUpdateCheckService.layer.pipe(
  Layer.provide(Layer.mergeAll(npmUpdateCheckPlatformLayer, npmRegistryLayer, npmUpdateCacheLayer)),
);
