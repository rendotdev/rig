import { posix } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  RigPathsConfigService,
  rigPathsConfigLiveLayer,
  RigPathsOptionsConfigService,
  type RigPathsPlatform,
  RigPathsPlatformService,
  RigPathsService,
} from "./rig-paths";

describe("Rig paths services", () => {
  test("builds every path from explicit configuration and dependencies", async () => {
    const homedir = vi.fn<() => string>(() => "/fallback-home");
    const cwd = vi.fn<() => string>(() => "/working");
    const platform: RigPathsPlatform = {
      homeDirectory: Effect.sync(homedir),
      workingDirectory: Effect.sync(cwd),
      dirname: (pathValue) => Effect.succeed(posix.dirname(pathValue)),
      isAbsolute: (pathValue) => Effect.succeed(posix.isAbsolute(pathValue)),
      join: (parts) => Effect.succeed(posix.join(...parts)),
      resolve: (parts) => Effect.succeed(posix.resolve(...parts)),
    };
    const optionsLayer = Layer.succeed(RigPathsOptionsConfigService, {
      homeDir: "configured-home",
    });
    const platformLayer = Layer.succeed(RigPathsPlatformService, platform);
    const configLayer = RigPathsConfigService.layer.pipe(
      Layer.provide(Layer.merge(optionsLayer, platformLayer)),
    );
    const pathsLayer = RigPathsService.layer.pipe(
      Layer.provide(Layer.merge(platformLayer, configLayer)),
    );

    const result = await Effect.gen(function* () {
      const values = yield* RigPathsConfigService;
      const paths = yield* RigPathsService;
      return {
        values,
        tilde: yield* paths.expandTilde("~/tools"),
        relative: yield* paths.resolve("relative/file.ts"),
        absolute: yield* paths.resolve("/absolute/file.ts"),
        worker: yield* paths.cronWorkerPath("daily"),
        parent: yield* paths.parentDir("/working/file.ts"),
      };
    }).pipe(Effect.provide(Layer.merge(configLayer, pathsLayer)), Effect.runPromise);

    expect(result.values.homeDir).toBe("/working/configured-home");
    expect(result.values.rigDir).toBe("/working/configured-home/rig");
    expect(result.values.legacyRigDir).toBe("/working/configured-home/.rig");
    expect(result.values.configPath).toBe("/working/configured-home/rig/rig.json");
    expect(result.values.runtimeDir).toBe("/working/configured-home/rig/runtime");
    expect(result.values.runtimeSdkPath).toBe("/working/configured-home/rig/runtime/sdk.ts");
    expect(result.values.runtimeTypesPath).toBe("/working/configured-home/rig/runtime/types.d.ts");
    expect(result.values.runtimeGlobalsPath).toBe(
      "/working/configured-home/rig/runtime/globals.d.ts",
    );
    expect(result.values.runtimeToolTsconfigPath).toBe(
      "/working/configured-home/rig/runtime/tsconfig.tools.json",
    );
    expect(result.values.cronDir).toBe("/working/configured-home/rig/cron");
    expect(result.values.logsDir).toBe("/working/configured-home/rig/.logs");
    expect(result.values.updateCheckCachePath).toBe(
      "/working/configured-home/rig/update-check.json",
    );
    expect(result.values.toolMetadataCachePath).toBe(
      "/working/configured-home/rig/tool-metadata.json",
    );
    expect(result.values.migrationPromptStatePath).toBe(
      "/working/configured-home/rig/migration-prompts.json",
    );
    expect(result.values.defaultBaseRegistryDir).toBe("~/rig/tools");
    expect(result.values.legacyDefaultBaseRegistryDir).toBe("~/.rig/tools");
    expect(result.tilde).toBe("/working/configured-home/tools");
    expect(result.relative).toBe("/working/relative/file.ts");
    expect(result.absolute).toBe("/absolute/file.ts");
    expect(result.worker).toBe("/working/configured-home/rig/cron/daily.ts");
    expect(result.parent).toBe("/working");
    expect(homedir).not.toHaveBeenCalled();
    expect(cwd).toHaveBeenCalled();
  });

  test("uses the platform home directory when no override is configured", async () => {
    const homedir = vi.fn<() => string>(() => "/fallback-home");
    const optionsLayer = Layer.succeed(RigPathsOptionsConfigService, {
      homeDir: undefined,
    });
    const platformLayer = Layer.succeed(RigPathsPlatformService, {
      homeDirectory: Effect.sync(homedir),
      workingDirectory: Effect.succeed("/working"),
      dirname: (pathValue) => Effect.succeed(posix.dirname(pathValue)),
      isAbsolute: (pathValue) => Effect.succeed(posix.isAbsolute(pathValue)),
      join: (parts) => Effect.succeed(posix.join(...parts)),
      resolve: (parts) => Effect.succeed(posix.resolve(...parts)),
    });

    const values = await Effect.service(RigPathsConfigService).pipe(
      Effect.provide(
        RigPathsConfigService.layer.pipe(Layer.provide(Layer.merge(optionsLayer, platformLayer))),
      ),
      Effect.runPromise,
    );

    expect(values.homeDir).toBe("/fallback-home");
    expect(values.rigDir).toBe("/fallback-home/rig");
    expect(homedir).toHaveBeenCalledOnce();
  });

  test("uses RIG_HOME in the production options layer", async () => {
    vi.stubEnv("RIG_HOME", "/environment-home");
    try {
      const values = await Effect.service(RigPathsConfigService).pipe(
        Effect.provide(rigPathsConfigLiveLayer),
        Effect.runPromise,
      );

      expect(values.homeDir).toBe("/environment-home");
      expect(values.configPath).toBe("/environment-home/rig/rig.json");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
