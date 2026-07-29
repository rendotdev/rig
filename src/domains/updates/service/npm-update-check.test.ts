import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { NpmUpdateCheckConfigService } from "../config/npm-update-check-config";
import { NpmRegistryPlatformService, NpmRegistryService } from "../repo/npm-registry";
import { NpmUpdateCacheService } from "../repo/update-cache";
import { NpmUpdateCheckPlatformService } from "../repo/update-check-platform";
import { NpmRegistryError } from "../types/updates";
import { NpmUpdateCheckService } from "./npm-update-check";

const homes: string[] = [];

const createHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-update-check-"));
  homes.push(home);
  return home;
};

const createUpdateCheckLayer = (params: {
  home: string;
  now?: number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  packageName?: string;
  updateCheckFlag?: string;
  fetchJson: NpmRegistryPlatformService["Service"]["fetchJson"];
}) => {
  const registryLayer = NpmRegistryService.layer.pipe(
    Layer.provide(Layer.succeed(NpmRegistryPlatformService, { fetchJson: params.fetchJson })),
  );
  return NpmUpdateCheckService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(NpmUpdateCheckConfigService, {
          get: Effect.succeed({
            updateCheckCachePath: join(params.home, "rig", "update-check.json"),
            cacheTtlMs: params.cacheTtlMs ?? 24 * 60 * 60 * 1000,
            timeoutMs: params.timeoutMs ?? 750,
            packageName: params.packageName ?? "@rendotdev/rig",
          }),
        }),
        Layer.succeed(NpmUpdateCheckPlatformService, {
          now: Effect.succeed(params.now ?? Date.now()),
          environmentFlag: Effect.fn("NpmUpdateCheckPlatformService.environmentFlag")(function* (
            name: string,
          ) {
            return name === "RIG_UPDATE_CHECK" ? params.updateCheckFlag : undefined;
          }),
        }),
        registryLayer,
        NpmUpdateCacheService.layer,
      ),
    ),
  );
};

const check = (currentVersion: string, layer: Layer.Layer<NpmUpdateCheckService, never, never>) =>
  Effect.runPromise(
    NpmUpdateCheckService.use((service) => service.check(currentVersion)).pipe(
      Effect.provide(layer),
    ),
  );

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("npm update checks", () => {
  test("skips checks when disabled", async () => {
    const home = await createHome();
    const layer = createUpdateCheckLayer({
      home,
      updateCheckFlag: "0",
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return yield* new NpmRegistryError({ cause: new Error("fetch should not be called") });
      }),
    });
    await expect(check("0.0.3", layer)).resolves.toBeUndefined();
  });

  test("fetches, caches, and renders newer npm versions", async () => {
    const home = await createHome();
    const urls: string[] = [];
    const fetchJson = Effect.fn("NpmRegistryPlatformService.fetchJson")(function* (url: string) {
      urls.push(url);
      return { ok: true, status: 200, data: { version: "1.2.4" } } as const;
    });
    const layer = createUpdateCheckLayer({
      home,
      now: 1000,
      packageName: "@scope/tool",
      fetchJson,
    });
    await expect(check("1.2.3", layer)).resolves.toMatchObject({
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      message: "Rig update available: @scope/tool 1.2.3 -> 1.2.4. Run npm install -g @scope/tool.",
    });
    expect(urls).toEqual(["https://registry.npmjs.org/%40scope%2Ftool/latest"]);
    const cachePath = join(home, "rig", "update-check.json");
    expect(await readFile(cachePath, "utf8")).toContain('"latestVersion": "1.2.4"');

    const cachedLayer = createUpdateCheckLayer({
      home,
      now: 1001,
      packageName: "@scope/tool",
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return yield* new NpmRegistryError({ cause: new Error("fresh cache should avoid fetch") });
      }),
    });
    await expect(check("1.2", cachedLayer)).resolves.toMatchObject({ latestVersion: "1.2.4" });
    await expect(check("1.2.3", cachedLayer)).resolves.toMatchObject({ latestVersion: "1.2.4" });
    await expect(check("1.2.4", cachedLayer)).resolves.toBeUndefined();
    await expect(check("1.2.5", cachedLayer)).resolves.toBeUndefined();

    await writeFile(cachePath, '{"checkedAt":1002,"latestVersion":"1.2"}\n', "utf8");
    const shorterLayer = createUpdateCheckLayer({
      home,
      now: 1003,
      packageName: "@scope/tool",
      fetchJson,
    });
    await expect(check("1.2.1", shorterLayer)).resolves.toBeUndefined();
  });

  test("ignores stale cache misses and invalid registry data", async () => {
    const home = await createHome();
    const cachePath = join(home, "rig", "update-check.json");
    await mkdir(join(home, "rig"), { recursive: true });
    await writeFile(cachePath, '{"checkedAt":1}\n', "utf8");
    const missingLayer = createUpdateCheckLayer({
      home,
      now: 10_000_000,
      cacheTtlMs: 1,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return { ok: false, status: 404, data: undefined } as const;
      }),
    });
    await expect(check("1.0.0", missingLayer)).resolves.toBeUndefined();

    const invalidLayer = createUpdateCheckLayer({
      home,
      now: 10_000_000,
      cacheTtlMs: 1,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return { ok: true, status: 200, data: { name: "rig" } } as const;
      }),
    });
    await expect(check("1.0.0", invalidLayer)).resolves.toBeUndefined();

    await writeFile(cachePath, "[]\n", "utf8");
    await expect(check("1.0.0", missingLayer)).resolves.toBeUndefined();
  });

  test("handles invalid cache files and registry timeouts", async () => {
    const home = await createHome();
    await mkdir(join(home, "rig"), { recursive: true });
    await writeFile(join(home, "rig", "update-check.json"), "{ nope", "utf8");
    const failureLayer = createUpdateCheckLayer({
      home,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return yield* new NpmRegistryError({ cause: new Error("network failed") });
      }),
    });
    await expect(check("1.0.0", failureLayer)).resolves.toBeUndefined();

    const timeoutLayer = createUpdateCheckLayer({
      home,
      timeoutMs: 1,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        return yield* Effect.never;
      }),
    });
    await expect(check("1.0.0", timeoutLayer)).resolves.toBeUndefined();
  });

  test("retries transient registry failures once and preserves permanent failures", async () => {
    const home = await createHome();
    let attempts = 0;
    const transientLayer = createUpdateCheckLayer({
      home,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        attempts += 1;
        return attempts === 1
          ? ({ ok: false, status: 503, data: undefined } as const)
          : ({ ok: true, status: 200, data: { version: "2.0.0" } } as const);
      }),
    });
    await expect(check("1.0.0", transientLayer)).resolves.toMatchObject({
      latestVersion: "2.0.0",
    });
    expect(attempts).toBe(2);

    const permanentHome = await createHome();
    let permanentAttempts = 0;
    const permanentLayer = createUpdateCheckLayer({
      home: permanentHome,
      fetchJson: Effect.fn("NpmRegistryPlatformService.fetchJson")(function* () {
        permanentAttempts += 1;
        return { ok: false, status: 404, data: undefined } as const;
      }),
    });
    await expect(check("1.0.0", permanentLayer)).resolves.toBeUndefined();
    expect(permanentAttempts).toBe(1);
  });
});
