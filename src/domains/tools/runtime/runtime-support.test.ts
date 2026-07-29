import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { atomicFileWriterLayer } from "../../../providers/filesystem/atomic-file-writer";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  rigPathsConfigLayer,
} from "../../../providers/paths/rig-paths";
import { RuntimeSupportService, runtimeSupportRendererLayer } from "./runtime-support";
import {
  ToolRuntimeInstructionRendererService,
  ToolRuntimeInstructionSyncService,
} from "./tool-runtime-instruction-sync";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";

const directories: string[] = [];

const makeDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

const makePathsConfigLayer = (homeDir: string) =>
  rigPathsConfigLayer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(RigPathsOptionsConfigService, { homeDir }),
        RigPathsPlatformService.layer,
      ),
    ),
  );

const makeRuntimeSupportLayer = (homeDir: string) => {
  const pathsLayer = makePathsConfigLayer(homeDir);
  const rendererLayer = runtimeSupportRendererLayer.pipe(Layer.provide(pathsLayer));
  return RuntimeSupportService.layer.pipe(
    Layer.provide(Layer.mergeAll(pathsLayer, atomicFileWriterLayer, rendererLayer)),
  );
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("renders the managed tool runtime prefix through its service layer", async () => {
  const result = await Effect.gen(function* () {
    const renderer = yield* ToolRuntimeInstructionRendererService;
    const current = yield* renderer.renderPrefix();
    const withShebang = yield* renderer.upsertPrefix("#!/usr/bin/env bun\nconsole.log(1);\n");
    const legacy = yield* renderer.upsertPrefix("// rig:tool-api-version 0\nconsole.log(1);\n");
    return { current, withShebang, legacy };
  }).pipe(Effect.provide(ToolRuntimeInstructionRendererService.layer), Effect.runPromise);

  expect(result.current).toContain("// rig:tool-api-version 2");
  expect(result.current).toContain("context.cache.query");
  expect(result.withShebang).toMatch(/^#!\/usr\/bin\/env bun\n\/\/ rig:runtime-reference:start/);
  expect(result.withShebang).toContain("// rig:tool-api-version 1");
  expect(result.legacy).toContain("// rig:tool-api-version 1");
});

test("syncs runtime instructions idempotently through service dependencies", async () => {
  const home = await makeDirectory("rig-runtime-sync-");
  const toolDir = join(home, "rig", "tools", "sample");
  const toolPath = join(toolDir, "index.rig.ts");
  await mkdir(toolDir, { recursive: true });
  await writeFile(toolPath, "export default {};\n", "utf8");
  const discovered = {
    name: "sample",
    registryKind: "base" as const,
    registryPath: join(home, "rig", "tools"),
    toolDir,
    toolPath,
  };
  const discoveryLayer = Layer.succeed(ToolDiscoveryService, {
    discover: () => Effect.succeed([discovered]),
    discoverRegistry: () => Effect.succeed([discovered]),
    find: () => Effect.succeed(discovered),
    projectRootFor: () => Effect.succeed(home),
  });
  const syncLayer = ToolRuntimeInstructionSyncService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        discoveryLayer,
        ToolRuntimeInstructionRendererService.layer,
        atomicFileWriterLayer,
      ),
    ),
  );

  const updates = await Effect.gen(function* () {
    const sync = yield* ToolRuntimeInstructionSyncService;
    return [yield* sync.sync, yield* sync.sync] as const;
  }).pipe(Effect.provide(syncLayer), Effect.runPromise);

  expect(updates[0].tools).toEqual([{ name: "sample", path: toolPath, changed: true }]);
  expect(updates[1].tools).toEqual([{ name: "sample", path: toolPath, changed: false }]);
  expect(await readFile(toolPath, "utf8")).toMatch(/^\/\/ rig:runtime-reference:start/);
});

test("generates runtime support without replacing a user registry config", async () => {
  const home = await makeDirectory("rig-runtime-support-");
  const registry = join(home, "custom-registry");
  const layer = makeRuntimeSupportLayer(home);

  await Effect.gen(function* () {
    const support = yield* RuntimeSupportService;
    yield* support.ensure([registry]);
  }).pipe(Effect.provide(layer), Effect.runPromise);

  const sdkPath = join(home, "rig", "runtime", "sdk.ts");
  const typesPath = join(home, "rig", "runtime", "types.d.ts");
  const registryConfigPath = join(registry, "tsconfig.json");
  expect(await readFile(sdkPath, "utf8")).toContain("function makeRigManagedProcess");
  expect(await readFile(typesPath, "utf8")).toContain("shell: RigShell");
  expect(await readFile(registryConfigPath, "utf8")).toContain("Generated by Rig");

  await writeFile(registryConfigPath, "{}\n", "utf8");
  await Effect.gen(function* () {
    yield* (yield* RuntimeSupportService).ensure([registry]);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  expect(await readFile(registryConfigPath, "utf8")).toBe("{}\n");
});
