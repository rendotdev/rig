import { Context, Effect, Layer } from "effect";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  RigPathsService,
  rigPathsLayer,
} from "../../../providers/paths/rig-paths";
import { RigConfigStoreService, rigConfigStoreLayer } from "../../settings/service/config-store";
import type { RigConfigMutator } from "../../settings/types/config-store";
import {
  RegistryDirectoryRepositoryService,
  registryDirectoryRepositoryLayer,
} from "../repo/registry-directory";
import type { RegistryConfigState } from "../types/registry";
import { RegistryStateService } from "./registry-state";
import { RigError } from "../../../providers/errors/rig-error";

export class RegistryService extends Context.Service<
  RegistryService,
  {
    readonly list: Effect.Effect<RegistryConfigState, RigError>;
    readonly add: (pathValue: string) => Effect.Effect<RegistryConfigState, RigError>;
    readonly remove: (pathValue: string) => Effect.Effect<RegistryConfigState, RigError>;
  }
>()("@rendotdev/rig/registry/RegistryService", {
  make: Effect.gen(function* () {
    const settings = yield* RigConfigStoreService;
    const states = yield* RegistryStateService;
    const directories = yield* RegistryDirectoryRepositoryService;
    const paths = yield* RigPathsService;
    const mapSettingsError = (error: { cause: unknown }): RigError =>
      error.cause instanceof RigError
        ? error.cause
        : new RigError({
            code: "CONFIG_INVALID",
            message: "Registry configuration failed.",
            details: { error: error.cause },
          });
    const updateSettings = Effect.fn("RegistryService.updateSettings")(function* (
      mutator: RigConfigMutator,
    ) {
      yield* settings.update(mutator).pipe(Effect.mapError(mapSettingsError));
    });
    const list = Effect.gen(function* () {
      const state = yield* states.forConfig(
        yield* settings.ensure.pipe(Effect.mapError(mapSettingsError)),
      );
      yield* directories.ensure(state.baseRegistryDir);
      return state;
    }).pipe(Effect.withSpan("RegistryService.list"));
    const add = Effect.fn("RegistryService.add")(function* (pathValue: string) {
      const current = yield* settings.ensure.pipe(Effect.mapError(mapSettingsError));
      const state = yield* states.forConfig(current);
      const target = yield* paths.resolve(pathValue);
      if (target === state.baseRegistryDir) {
        return yield* new RigError({
          code: "CONFIG_INVALID",
          message: "The base registry is already configured.",
          details: { path: target },
        });
      }
      if (!state.customRegistries.includes(target)) {
        yield* directories.ensure(target);
        yield* updateSettings((latest) => ({
          ...latest,
          customRegistries: [...latest.customRegistries, pathValue],
        }));
      }
      return yield* list;
    });
    const remove = Effect.fn("RegistryService.remove")(function* (pathValue: string) {
      const current = yield* settings.ensure.pipe(Effect.mapError(mapSettingsError));
      const target = yield* paths.resolve(pathValue);
      const resolved = yield* Effect.forEach(current.customRegistries, (entry) =>
        paths.resolve(entry).pipe(Effect.map((path) => ({ entry, path }))),
      );
      const removed = new Set(
        resolved.filter((entry) => entry.path === target).map((entry) => entry.entry),
      );
      if (removed.size === 0) {
        return yield* new RigError({
          code: "CONFIG_INVALID",
          message: `Registry is not configured: ${pathValue}`,
          details: { path: target },
        });
      }
      yield* updateSettings((latest) => ({
        ...latest,
        customRegistries: latest.customRegistries.filter((entry) => !removed.has(entry)),
      }));
      return yield* list;
    });
    return { list, add, remove } as const;
  }),
}) {
  static readonly layer = Layer.effect(RegistryService, RegistryService.make);
}

const registryStateLayer = RegistryStateService.layer.pipe(Layer.provide(rigPathsLayer));
const registryDependenciesLayer = Layer.mergeAll(
  rigConfigStoreLayer,
  registryStateLayer,
  registryDirectoryRepositoryLayer,
  rigPathsLayer,
);
export const registryLayer: Layer.Layer<
  RegistryService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = RegistryService.layer.pipe(Layer.provide(registryDependenciesLayer));
