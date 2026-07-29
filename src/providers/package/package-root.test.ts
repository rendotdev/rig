import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { RigError } from "../errors/rig-error";
import {
  type PackageRootDependencies,
  PackageRootPlatformService,
  PackageRootService,
} from "./package-root";

function createHarness() {
  const state = {
    environmentRoot: undefined as string | undefined,
    argvEntrypoint: undefined as string | undefined,
    execPath: "/runtime/bin/node",
  };
  const existingPaths = new Set<string>();
  const realpaths = new Map<string, string>();
  const getEnvironmentRoot = vi.fn(() => state.environmentRoot);
  const getArgvEntrypoint = vi.fn(() => state.argvEntrypoint);
  const getExecPath = vi.fn(() => state.execPath);
  const dependencies: PackageRootDependencies = {
    getEnvironmentRoot,
    getArgvEntrypoint,
    getExecPath,
    exists: (pathValue) => existingPaths.has(pathValue),
    realpath: (pathValue) => {
      const realpath = realpaths.get(pathValue);
      if (realpath) return realpath;
      throw new Error(`Missing path: ${pathValue}`);
    },
    basename: posix.basename,
    dirname: posix.dirname,
    join: posix.join,
    resolve: posix.resolve,
    fileURLToPath,
  };
  const layer = PackageRootService.layer.pipe(
    Layer.provide(
      Layer.succeed(PackageRootPlatformService, {
        environmentRoot: Effect.sync(dependencies.getEnvironmentRoot),
        argvEntrypoint: Effect.sync(dependencies.getArgvEntrypoint),
        execPath: Effect.sync(dependencies.getExecPath),
        exists: (pathValue) => Effect.sync(() => dependencies.exists(pathValue)),
        realpath: (pathValue) =>
          Effect.try({
            try: () => dependencies.realpath(pathValue),
            catch: (cause) =>
              new RigError({
                code: "INTERNAL_ERROR",
                message: cause instanceof Error ? cause.message : String(cause),
                details: { cause },
              }),
          }),
        basename: (pathValue) => Effect.sync(() => dependencies.basename(pathValue)),
        dirname: (pathValue) => Effect.sync(() => dependencies.dirname(pathValue)),
        join: (parts) => Effect.sync(() => dependencies.join(...parts)),
        resolve: (pathValue) => Effect.sync(() => dependencies.resolve(pathValue)),
        fileUrlToPath: (metaUrl) => Effect.sync(() => dependencies.fileURLToPath(metaUrl)),
      }),
    ),
  );
  const run = <Result>(
    operation: (service: PackageRootService["Service"]) => Effect.Effect<Result>,
  ) => Effect.runSync(PackageRootService.use(operation).pipe(Effect.provide(layer)));
  return {
    run,
    state,
    existingPaths,
    realpaths,
    getEnvironmentRoot,
    getArgvEntrypoint,
  };
}

describe("PackageRootService", () => {
  it("preserves environment, argv, executable, and Bun lookup precedence", () => {
    const harness = createHarness();
    harness.state.environmentRoot = "/configured/../configured-root";
    expect(harness.run((service) => service.find("file:///module.ts"))).toBe("/configured-root");
    expect(harness.getArgvEntrypoint).not.toHaveBeenCalled();

    harness.state.environmentRoot = undefined;
    harness.state.argvEntrypoint = "/workspace/src/cli.ts";
    harness.realpaths.set("/workspace/src/cli.ts", "/workspace/src/cli.ts");
    expect(harness.run((service) => service.find("file:///module.ts"))).toBe("/workspace");

    harness.state.argvEntrypoint = "/missing/cli.ts";
    harness.state.execPath = "/installed/dist/rig.mjs";
    harness.realpaths.set("/installed/dist/rig.mjs", "/installed/dist/rig.mjs");
    expect(harness.run((service) => service.find("file:///module.ts"))).toBe("/installed");

    harness.state.execPath = "/bun/bin/bun";
    expect(harness.run((service) => service.find("file:///$bunfs/root"))).toBe("/bun/bin");
    expect(harness.getEnvironmentRoot).toHaveBeenCalledTimes(4);
  });

  it("reads dynamic process and environment dependencies for every find call", () => {
    const harness = createHarness();
    harness.state.environmentRoot = "/first";
    expect(harness.run((service) => service.find("file:///module.ts"))).toBe("/first");
    harness.state.environmentRoot = "/second";
    expect(harness.run((service) => service.find("file:///module.ts"))).toBe("/second");
    expect(harness.getEnvironmentRoot).toHaveBeenCalledTimes(2);
  });

  it("resolves entrypoints through realpaths and safe absolute fallbacks", () => {
    const harness = createHarness();
    expect(harness.run((service) => service.fromEntrypoint(undefined))).toBeUndefined();
    harness.realpaths.set("/link", "/repo/src/cli.ts");
    expect(harness.run((service) => service.fromEntrypoint("/link"))).toBe("/repo");
    harness.realpaths.set("/dist-link", "/repo/dist/rig.mjs");
    expect(harness.run((service) => service.fromEntrypoint("/dist-link"))).toBe("/repo");
    harness.realpaths.set("/other", "/repo/bin/rig");
    expect(harness.run((service) => service.fromEntrypoint("/other"))).toBeUndefined();
    harness.existingPaths.add("/repo/src/fallback.ts");
    expect(harness.run((service) => service.fromEntrypoint("/repo/src/fallback.ts"))).toBe("/repo");
    expect(harness.run((service) => service.fromEntrypoint("/missing"))).toBeUndefined();
  });

  it("finds package files from modules and preserves the final fallback", () => {
    const harness = createHarness();
    harness.state.argvEntrypoint = "/missing/cli.ts";
    harness.state.execPath = "/missing/node";
    harness.existingPaths.add("/workspace/package.json");
    expect(
      harness.run((service) => service.fromModule("file:///workspace/src/deep/module.ts")),
    ).toBe("/workspace");
    expect(harness.run((service) => service.find("file:///workspace/src/deep/module.ts"))).toBe(
      "/workspace",
    );
    expect(
      harness.run((service) =>
        service.packageFile("file:///workspace/src/deep/module.ts", "dist", "rig.mjs"),
      ),
    ).toBe("/workspace/dist/rig.mjs");
    harness.existingPaths.clear();
    expect(harness.run((service) => service.fromModule("file:///module.ts"))).toBeUndefined();
    expect(
      harness.run((service) => service.fromModule("file:///a/b/c/d/e/f/g/h/i/j/module.ts")),
    ).toBeUndefined();
    expect(harness.run((service) => service.find("file:///a/b/c/d/e/f/g/h/i/j/module.ts"))).toBe(
      "/a/b/c/d/e/f/g/h",
    );
  });
});
