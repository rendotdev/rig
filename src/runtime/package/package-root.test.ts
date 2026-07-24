import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { RigPackageRootClass, RigPackageRootService, rigPackageRoot } from "./package-root";

function createHarness() {
  const state: {
    environmentRoot: string | undefined;
    argvEntrypoint: string | undefined;
    execPath: string;
  } = {
    environmentRoot: undefined,
    argvEntrypoint: undefined,
    execPath: "/runtime/bin/node",
  };
  const existingPaths = new Set<string>();
  const realpaths = new Map<string, string>();
  const getRigPackageRootEnvironment = vi.fn<() => string | undefined>(
    function getRigPackageRootEnvironment() {
      return state.environmentRoot;
    },
  );
  const getArgvEntrypoint = vi.fn<() => string | undefined>(function getArgvEntrypoint() {
    return state.argvEntrypoint;
  });
  const getExecPath = vi.fn<() => string>(function getExecPath() {
    return state.execPath;
  });

  const Service = new RigPackageRootService({
    params: {},
    deps: {
      getRigPackageRootEnvironment,
      getArgvEntrypoint,
      getExecPath,
      existsSync(pathValue) {
        return existingPaths.has(pathValue);
      },
      realpathSync(pathValue) {
        const realpath = realpaths.get(pathValue);
        if (realpath) return realpath;
        throw new Error(`Missing path: ${pathValue}`);
      },
      basename: posix.basename,
      dirname: posix.dirname,
      join: posix.join,
      resolve: posix.resolve,
      fileURLToPath,
    },
  });

  return {
    Service,
    state,
    existingPaths,
    realpaths,
    getRigPackageRootEnvironment,
    getArgvEntrypoint,
    getExecPath,
  };
}

describe("RigPackageRootService", () => {
  it("preserves environment, argv, executable, and Bun lookup precedence", () => {
    const harness = createHarness();

    harness.state.environmentRoot = "/configured/../configured-root";
    expect(harness.Service.find({ metaUrl: "file:///module.ts" })).toBe("/configured-root");
    expect(harness.getArgvEntrypoint).not.toHaveBeenCalled();

    harness.state.environmentRoot = undefined;
    harness.state.argvEntrypoint = "/workspace/src/cli.ts";
    harness.realpaths.set("/workspace/src/cli.ts", "/workspace/src/cli.ts");
    expect(harness.Service.find({ metaUrl: "file:///module.ts" })).toBe("/workspace");

    harness.state.argvEntrypoint = "/missing/cli.ts";
    harness.state.execPath = "/installed/dist/rig.mjs";
    harness.realpaths.set("/installed/dist/rig.mjs", "/installed/dist/rig.mjs");
    expect(harness.Service.find({ metaUrl: "file:///module.ts" })).toBe("/installed");

    harness.state.execPath = "/bun/bin/bun";
    expect(harness.Service.find({ metaUrl: "file:///$bunfs/root" })).toBe("/bun/bin");
    expect(harness.getRigPackageRootEnvironment).toHaveBeenCalledTimes(4);
  });

  it("reads dynamic process and environment dependencies for every find call", () => {
    const harness = createHarness();

    harness.state.environmentRoot = "/first";
    expect(harness.Service.find({ metaUrl: "file:///module.ts" })).toBe("/first");

    harness.state.environmentRoot = "/second";
    expect(harness.Service.find({ metaUrl: "file:///module.ts" })).toBe("/second");
    expect(harness.getRigPackageRootEnvironment).toHaveBeenCalledTimes(2);
  });

  it("resolves entrypoints through realpaths and safe absolute fallbacks", () => {
    const harness = createHarness();

    expect(harness.Service.fromEntrypoint({ entrypoint: undefined })).toBeUndefined();
    harness.realpaths.set("/link", "/repo/src/cli.ts");
    expect(harness.Service.fromEntrypoint({ entrypoint: "/link" })).toBe("/repo");
    harness.realpaths.set("/dist-link", "/repo/dist/rig.mjs");
    expect(harness.Service.fromEntrypoint({ entrypoint: "/dist-link" })).toBe("/repo");
    harness.realpaths.set("/other", "/repo/bin/rig");
    expect(harness.Service.fromEntrypoint({ entrypoint: "/other" })).toBeUndefined();

    harness.existingPaths.add("/repo/src/fallback.ts");
    expect(harness.Service.fromEntrypoint({ entrypoint: "/repo/src/fallback.ts" })).toBe("/repo");
    expect(harness.Service.fromEntrypoint({ entrypoint: "/missing" })).toBeUndefined();
  });

  it("finds package files from modules and preserves the final fallback", () => {
    const harness = createHarness();
    harness.state.argvEntrypoint = "/missing/cli.ts";
    harness.state.execPath = "/missing/node";
    harness.existingPaths.add("/workspace/package.json");

    expect(harness.Service.fromModule({ metaUrl: "file:///workspace/src/deep/module.ts" })).toBe(
      "/workspace",
    );
    expect(harness.Service.find({ metaUrl: "file:///workspace/src/deep/module.ts" })).toBe(
      "/workspace",
    );
    expect(
      harness.Service.packageFile({
        metaUrl: "file:///workspace/src/deep/module.ts",
        parts: ["dist", "rig.mjs"],
      }),
    ).toBe("/workspace/dist/rig.mjs");

    harness.existingPaths.clear();
    expect(harness.Service.fromModule({ metaUrl: "file:///module.ts" })).toBeUndefined();
    expect(
      harness.Service.fromModule({ metaUrl: "file:///a/b/c/d/e/f/g/h/i/j/module.ts" }),
    ).toBeUndefined();
    expect(harness.Service.find({ metaUrl: "file:///a/b/c/d/e/f/g/h/i/j/module.ts" })).toBe(
      "/a/b/c/d/e/f/g/h",
    );
  });

  it("keeps class-free legacy adapters and variadic packageFile behavior", () => {
    const PackageRoot = new RigPackageRootClass();
    const root = PackageRoot.find(import.meta.url);

    expect(PackageRoot).toBeInstanceOf(RigPackageRootClass);
    expect(rigPackageRoot).toBeInstanceOf(RigPackageRootClass);
    expect(PackageRoot.packageFile(import.meta.url, "dist", "rig.mjs")).toBe(
      posix.join(root, "dist", "rig.mjs"),
    );
    expect(PackageRoot.fromEntrypoint(undefined)).toBeUndefined();
  });
});
