import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
} from "../../../providers/paths/rig-paths";
import { RigHomeDirectoryMigrationPromptId } from "../config/directory-migration";
import { RigConfigError } from "../types/config-error";
import { RigConfigStoreService, rigConfigStoreLayer } from "./config-store";

const homes: string[] = [];

const makeTestConfigLayer = (homeDir: string) => {
  const optionsLayer = Layer.succeed(RigPathsOptionsConfigService, { homeDir });
  return rigConfigStoreLayer.pipe(
    Layer.provide(Layer.merge(optionsLayer, RigPathsPlatformService.layer)),
  );
};

const createHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-config-test-"));
  homes.push(home);
  return home;
};

const runConfig = <Value>(
  home: string,
  use: (service: typeof RigConfigStoreService.Service) => Effect.Effect<Value, unknown>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* RigConfigStoreService);
  }).pipe(Effect.provide(makeTestConfigLayer(home)), Effect.runPromise);

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("RigConfigStoreService", () => {
  test("creates first-run settings without generating tool runtime support", async () => {
    const home = await createHome();
    const config = await runConfig(home, (service) => service.ensure);

    expect(config).toMatchObject({ version: 1, baseRegistryDir: "~/rig/tools" });
    expect(existsSync(join(home, "rig", "rig.json"))).toBe(true);
    expect(existsSync(join(home, "rig", "runtime"))).toBe(false);
  });

  test("migrates legacy state and rewrites the legacy registry path", async () => {
    const home = await createHome();
    await mkdir(join(home, ".rig", "tools", "legacy"), { recursive: true });
    await writeFile(
      join(home, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/.rig/tools", customRegistries: [] })}\n`,
    );

    const result = await runConfig(home, (service) =>
      Effect.gen(function* () {
        const config = yield* service.ensure;
        return { config, migration: yield* service.migrationResult };
      }),
    );

    expect(result.migration).toMatchObject({ status: "migrated", configUpdated: true });
    expect(result.config.baseRegistryDir).toBe("~/rig/tools");
    expect(existsSync(join(home, ".rig"))).toBe(false);
  });

  test("records a manual migration prompt exactly once", async () => {
    const home = await createHome();
    await mkdir(join(home, ".rig", "tools", "legacy"), { recursive: true });
    await mkdir(join(home, "rig", "tools", "current"), { recursive: true });
    await writeFile(
      join(home, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/.rig/tools", customRegistries: [] })}\n`,
    );
    await writeFile(
      join(home, "rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/rig/tools", customRegistries: [], cronJobs: [] })}\n`,
    );

    await runConfig(home, (service) =>
      Effect.gen(function* () {
        yield* service.ensure;
        expect(yield* service.migrationResult).toMatchObject({ status: "manual" });
        yield* service.acknowledgeMigrationPrompt;
        yield* service.acknowledgeMigrationPrompt;
      }),
    );

    const state = await readFile(join(home, "rig", "migration-prompts.json"), "utf8");
    expect(state).toContain(RigHomeDirectoryMigrationPromptId);
  });

  test("serializes concurrent updates without losing changes", async () => {
    const home = await createHome();
    await runConfig(home, (service) => service.ensure);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runConfig(home, (service) =>
          service.update((config) => ({
            ...config,
            customRegistries: [...config.customRegistries, `registry-${index}`],
          })),
        ),
      ),
    );

    const config = await runConfig(home, (service) => service.read);
    expect(config.customRegistries.toSorted()).toEqual(
      Array.from({ length: 12 }, (_, index) => `registry-${index}`).toSorted(),
    );
    expect(existsSync(`${join(home, "rig", "rig.json")}.lock`)).toBe(false);
  });

  test("releases the lock after a failed mutator", async () => {
    const home = await createHome();
    await runConfig(home, (service) => service.ensure);
    await expect(
      runConfig(home, (service) => service.update(() => Promise.reject(new Error("failed")))),
    ).rejects.toBeInstanceOf(RigConfigError);
    expect(existsSync(`${join(home, "rig", "rig.json")}.lock`)).toBe(false);
  });
});
