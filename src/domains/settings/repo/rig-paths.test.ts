import { posix } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { type PathOptions, RigPathsClass, RigPaths, RigPathsRepo } from "./rig-paths";

const pathDeps = {
  dirname: posix.dirname,
  isAbsolute: posix.isAbsolute,
  join: posix.join,
  resolve: posix.resolve,
};

describe("Rig paths", () => {
  test("builds every path from stable config and replaceable dependencies", () => {
    const homedir = vi.fn<() => string>(() => "/fallback-home");
    const cwd = vi.fn<() => string>(() => "/working");
    const Paths = new RigPathsRepo({
      params: {
        homeDir: "configured-home",
        defaultBaseRegistryDirValue: "~/rig/tools",
        legacyDefaultBaseRegistryDirValue: "~/.rig/tools",
      },
      deps: { homedir, cwd, ...pathDeps },
    });

    expect(Paths.homeDir({})).toBe("/working/configured-home");
    expect(Paths.expandTilde({ pathValue: "~" })).toBe("/working/configured-home");
    expect(Paths.expandTilde({ pathValue: "~/tools" })).toBe("/working/configured-home/tools");
    expect(Paths.expandTilde({ pathValue: "relative" })).toBe("relative");
    expect(Paths.resolve({ pathValue: "relative/file.ts" })).toBe("/working/relative/file.ts");
    expect(Paths.resolve({ pathValue: "/absolute/file.ts" })).toBe("/absolute/file.ts");
    expect(Paths.rigDir({})).toBe("/working/configured-home/rig");
    expect(Paths.legacyRigDir({})).toBe("/working/configured-home/.rig");
    expect(Paths.configPath({})).toBe("/working/configured-home/rig/rig.json");
    expect(Paths.runtimeDir({})).toBe("/working/configured-home/rig/runtime");
    expect(Paths.runtimeSdkPath({})).toBe("/working/configured-home/rig/runtime/sdk.ts");
    expect(Paths.runtimeTypesPath({})).toBe("/working/configured-home/rig/runtime/types.d.ts");
    expect(Paths.runtimeGlobalsPath({})).toBe("/working/configured-home/rig/runtime/globals.d.ts");
    expect(Paths.runtimeToolTsconfigPath({})).toBe(
      "/working/configured-home/rig/runtime/tsconfig.tools.json",
    );
    expect(Paths.cronDir({})).toBe("/working/configured-home/rig/cron");
    expect(Paths.logsDir({})).toBe("/working/configured-home/rig/.logs");
    expect(Paths.cronWorkerPath({ name: "daily" })).toBe(
      "/working/configured-home/rig/cron/daily.ts",
    );
    expect(Paths.updateCheckCachePath({})).toBe("/working/configured-home/rig/update-check.json");
    expect(Paths.toolMetadataCachePath({})).toBe("/working/configured-home/rig/tool-metadata.json");
    expect(Paths.migrationPromptStatePath({})).toBe(
      "/working/configured-home/rig/migration-prompts.json",
    );
    expect(Paths.defaultBaseRegistryDir({})).toBe("~/rig/tools");
    expect(Paths.legacyDefaultBaseRegistryDir({})).toBe("~/.rig/tools");
    expect(Paths.parentDir({ pathValue: "/working/file.ts" })).toBe("/working");
    expect(homedir).not.toHaveBeenCalled();
    expect(cwd).toHaveBeenCalled();
  });

  test("uses the replaceable home directory dependency without an override", () => {
    const homedir = vi.fn<() => string>(() => "/fallback-home");
    const Paths = new RigPathsRepo({
      params: {
        homeDir: undefined,
        defaultBaseRegistryDirValue: "~/rig/tools",
        legacyDefaultBaseRegistryDirValue: "~/.rig/tools",
      },
      deps: { homedir, cwd: () => "/working", ...pathDeps },
    });

    expect(Paths.homeDir({})).toBe("/fallback-home");
    expect(Paths.rigDir({})).toBe("/fallback-home/rig");
    expect(homedir).toHaveBeenCalled();
    expect(RigPaths.homeDir({})).toBeTruthy();
  });

  test("preserves legacy getters, positional methods, options, and instanceof", () => {
    const options: PathOptions = { homeDir: "/legacy-home" };
    const paths = new RigPathsClass(options);

    expect(paths).toBeInstanceOf(RigPathsClass);
    expect(paths.homeDir).toBe("/legacy-home");
    expect(paths.rigDir).toBe("/legacy-home/rig");
    expect(paths.legacyRigDir).toBe("/legacy-home/.rig");
    expect(paths.configPath).toBe("/legacy-home/rig/rig.json");
    expect(paths.runtimeDir).toBe("/legacy-home/rig/runtime");
    expect(paths.runtimeSdkPath).toBe("/legacy-home/rig/runtime/sdk.ts");
    expect(paths.runtimeTypesPath).toBe("/legacy-home/rig/runtime/types.d.ts");
    expect(paths.runtimeGlobalsPath).toBe("/legacy-home/rig/runtime/globals.d.ts");
    expect(paths.runtimeToolTsconfigPath).toBe("/legacy-home/rig/runtime/tsconfig.tools.json");
    expect(paths.cronDir).toBe("/legacy-home/rig/cron");
    expect(paths.logsDir).toBe("/legacy-home/rig/.logs");
    expect(paths.updateCheckCachePath).toBe("/legacy-home/rig/update-check.json");
    expect(paths.toolMetadataCachePath).toBe("/legacy-home/rig/tool-metadata.json");
    expect(paths.migrationPromptStatePath).toBe("/legacy-home/rig/migration-prompts.json");
    expect(paths.defaultBaseRegistryDir).toBe("~/rig/tools");
    expect(paths.legacyDefaultBaseRegistryDir).toBe("~/.rig/tools");
    expect(paths.expandTilde("~/tools")).toBe("/legacy-home/tools");
    expect(paths.resolve("relative/file.ts")).toBe(
      posix.resolve(process.cwd(), "relative/file.ts"),
    );
    expect(paths.cronWorkerPath("daily")).toBe("/legacy-home/rig/cron/daily.ts");
    expect(paths.parentDir("/legacy-home/file.ts")).toBe("/legacy-home");
    expect(new RigPathsClass().homeDir).toBeTruthy();
  });
});
