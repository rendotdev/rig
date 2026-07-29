import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import type { RegistryEntry } from "../types/registry";
import { RegistryService } from "./registry";
import { ToolDiscoveryService, toolDiscoveryLayer } from "./tool-discovery";

const homes: string[] = [];

const makeDiscoveryLayer = (home: string, registries: RegistryEntry[]) => {
  const state = {
    baseRegistryDir: registries[0]?.path ?? join(home, "base"),
    customRegistries: registries.slice(1).map((entry) => entry.path),
    registries,
  };
  const registryLayer = Layer.succeed(RegistryService, {
    list: Effect.succeed(state),
    add: () => Effect.succeed(state),
    remove: () => Effect.succeed(state),
  });
  const pathsLayer = Layer.succeed(RigPathsService, {
    expandTilde: (value) => Effect.succeed(value.replace(/^~(?=\/|$)/, home)),
    resolve: (value) => Effect.succeed(resolve(value.replace(/^~(?=\/|$)/, home))),
    cronWorkerPath: (name) => Effect.succeed(join(home, "rig", "cron", `${name}.ts`)),
    parentDir: (value) => Effect.succeed(resolve(value, "..")),
  });
  return toolDiscoveryLayer.pipe(Layer.provide(Layer.merge(registryLayer, pathsLayer)));
};

const createHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-discovery-test-"));
  homes.push(home);
  return home;
};

const runDiscovery = <Value>(
  layer: Layer.Layer<ToolDiscoveryService>,
  use: (service: typeof ToolDiscoveryService.Service) => Effect.Effect<Value, unknown>,
) => ToolDiscoveryService.use(use).pipe(Effect.provide(layer), Effect.runPromise);

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("ToolDiscoveryService", () => {
  test("discovers supported entry files", async () => {
    const home = await createHome();
    const registryPath = join(home, "tools");
    const toolDir = join(registryPath, "view-tool");
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "index.rig.tsx"), "export default {};\n", "utf8");
    const layer = makeDiscoveryLayer(home, [{ kind: "base", path: registryPath }]);

    const tools = await runDiscovery(layer, (service) => service.discover());

    expect(tools).toMatchObject([{ name: "view-tool", toolPath: join(toolDir, "index.rig.tsx") }]);
    await expect(
      runDiscovery(layer, (service) => service.find("view-tool")),
    ).resolves.toMatchObject({ name: "view-tool", toolPath: join(toolDir, "index.rig.tsx") });
  });

  test("rejects legacy and duplicate tool entries", async () => {
    const home = await createHome();
    const base = join(home, "base");
    const custom = join(home, "custom");
    await mkdir(join(base, "legacy"), { recursive: true });
    await writeFile(join(base, "legacy", "tool.ts"), "export default {};\n", "utf8");
    const legacyLayer = makeDiscoveryLayer(home, [{ kind: "base", path: base }]);
    await expect(runDiscovery(legacyLayer, (service) => service.discover())).rejects.toThrow(
      "Tool legacy must use index.rig.ts or index.rig.tsx.",
    );
    await rm(join(base, "legacy"), { recursive: true, force: true });

    await Promise.all(
      [base, custom].map(async (registryPath) => {
        await mkdir(join(registryPath, "sample"), { recursive: true });
        await writeFile(join(registryPath, "sample", "index.rig.ts"), "export default {};\n");
      }),
    );
    const duplicateLayer = makeDiscoveryLayer(home, [
      { kind: "base", path: base },
      { kind: "custom", path: custom },
    ]);
    await expect(runDiscovery(duplicateLayer, (service) => service.discover())).rejects.toThrow(
      "Duplicate tool name: sample",
    );
    await expect(runDiscovery(duplicateLayer, (service) => service.find("sample"))).rejects.toThrow(
      "Duplicate tool name: sample",
    );
  });

  test("rejects invalid names and files that are not tool directories", async () => {
    const home = await createHome();
    const registryPath = join(home, "tools");
    await mkdir(registryPath, { recursive: true });
    await writeFile(join(registryPath, "plain-file"), "not a tool\n", "utf8");
    const layer = makeDiscoveryLayer(home, [{ kind: "base", path: registryPath }]);

    await expect(runDiscovery(layer, (service) => service.find("../sample"))).rejects.toThrow(
      "Tool not found: ../sample",
    );
    await expect(runDiscovery(layer, (service) => service.find("plain-file"))).rejects.toThrow(
      "Tool not found: plain-file",
    );
  });
});
