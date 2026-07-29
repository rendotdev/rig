import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import { RigConfigStoreService } from "../../settings/service/config-store";
import type { RigConfig } from "../../settings/types/config-schema";
import { RegistryDirectoryRepositoryService } from "../repo/registry-directory";
import { RegistryService } from "./registry";
import { RegistryStateService } from "./registry-state";

const directories: string[] = [];

const makeTestRegistryLayer = (home: string) => {
  let current: RigConfig = {
    version: 1 as const,
    baseRegistryDir: join(home, "base"),
    customRegistries: [] as string[],
    cronJobs: [],
  };
  const settingsLayer = Layer.succeed(RigConfigStoreService, {
    migrationResult: Effect.as(Effect.void, undefined),
    acknowledgeMigrationPrompt: Effect.void,
    ensure: Effect.sync(() => current),
    read: Effect.sync(() => current),
    write: (config) => Effect.sync(() => void (current = config)),
    update: (mutator) =>
      Effect.promise(() => Promise.resolve(mutator(current))).pipe(
        Effect.tap((updated) => Effect.sync(() => void (current = updated))),
      ),
  });
  const pathsLayer = Layer.succeed(RigPathsService, {
    expandTilde: (value) => Effect.succeed(value.replace(/^~(?=\/|$)/, home)),
    resolve: (value) => Effect.succeed(resolve(value.replace(/^~(?=\/|$)/, home))),
    cronWorkerPath: (name) => Effect.succeed(join(home, "rig", "cron", `${name}.ts`)),
    parentDir: (value) => Effect.succeed(resolve(value, "..")),
  });
  const stateLayer = RegistryStateService.layer.pipe(Layer.provide(pathsLayer));
  return RegistryService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        settingsLayer,
        stateLayer,
        pathsLayer,
        RegistryDirectoryRepositoryService.layer,
      ),
    ),
  );
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RegistryService", () => {
  test("adds, lists, and removes a custom registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-registry-test-"));
    directories.push(home);
    const custom = join(home, "custom");
    const result = await Effect.gen(function* () {
      const registry = yield* RegistryService;
      const added = yield* registry.add(custom);
      const listed = yield* registry.list;
      const removed = yield* registry.remove(custom);
      return { added, listed, removed };
    }).pipe(Effect.provide(makeTestRegistryLayer(home)), Effect.runPromise);

    expect(result.added.customRegistries).toEqual([custom]);
    expect(result.listed.registries).toContainEqual({ kind: "custom", path: custom });
    expect(result.removed.customRegistries).toEqual([]);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(home, "base"))).toBe(true);
  });

  test("rejects the base registry and missing removals", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-registry-test-"));
    directories.push(home);
    const layer = makeTestRegistryLayer(home);

    const addBase = Effect.gen(function* () {
      return yield* (yield* RegistryService).add(join(home, "base"));
    }).pipe(Effect.provide(layer), Effect.runPromise);
    const removeMissing = Effect.gen(function* () {
      return yield* (yield* RegistryService).remove(join(home, "missing"));
    }).pipe(Effect.provide(layer), Effect.runPromise);

    await expect(addBase).rejects.toThrow("already configured");
    await expect(removeMissing).rejects.toThrow("not configured");
  });
});
