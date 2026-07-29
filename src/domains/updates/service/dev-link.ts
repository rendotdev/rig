import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { DevLinkConfigService } from "../config/dev-link-config";
import { devLinkRepositoryLayer, DevLinkPlatformService } from "../repo/dev-link-repository";
import type { DevLinkCommandOptions, DevLinkStatus, ExistingDevLinkShim } from "../types/dev-link";

export class DevLinkPathService extends Context.Service<
  DevLinkPathService,
  {
    readonly repoRoot: Effect.Effect<string, RigError>;
    readonly binDirectory: (path?: string) => Effect.Effect<string>;
    readonly shimPath: (binDirectory: string) => Effect.Effect<string>;
    readonly shimSource: (repoRoot: string) => Effect.Effect<string>;
    readonly binDirectoryOnPath: (path: string) => Effect.Effect<boolean>;
  }
>()("@rendotdev/rig/updates/DevLinkPathService", {
  make: Effect.gen(function* () {
    const config = yield* (yield* DevLinkConfigService).get;
    const platform = yield* DevLinkPlatformService;
    const repoRoot = Effect.gen(function* () {
      const path = yield* platform.resolve(config.repoRoot);
      const packagePath = yield* platform.join([path, "package.json"]);
      const cliPath = yield* platform.join([path, "src", "app", "cli", "entrypoint.ts"]);
      const isMissingRigEntrypoint =
        !(yield* platform.exists(packagePath)) || !(yield* platform.exists(cliPath));
      if (isMissingRigEntrypoint) {
        return yield* new RigError({
          code: "DEV_LINK_ERROR",
          message: "Run dev link from the Rig repository root.",
          details: { repoRoot: path, expected: ["package.json", "src/app/cli/entrypoint.ts"] },
        });
      }
      return path;
    }).pipe(Effect.withSpan("DevLinkPathService.repoRoot"));
    const binDirectory = Effect.fn("DevLinkPathService.binDirectory")(function* (path?: string) {
      return path
        ? yield* platform.resolve(path)
        : yield* platform.join([config.homeDir, ".local", "bin"]);
    });
    const shimPath = Effect.fn("DevLinkPathService.shimPath")(function* (binDir: string) {
      return yield* platform.join([binDir, config.platform === "win32" ? "rig.cmd" : "rig"]);
    });
    const shimSource = Effect.fn("DevLinkPathService.shimSource")(function* (root: string) {
      return config.platform === "win32"
        ? `@echo off\nrem Rig dev shim. Safe to overwrite with \`rig dev link\`.\nset "RIG_DEV_REPO=${root}"\nbun --install=fallback run "%RIG_DEV_REPO%\\src\\app\\cli\\entrypoint.ts" %*\n`
        : `#!/bin/sh\n# Rig dev shim. Safe to overwrite with \`rig dev link\`.\nRIG_DEV_REPO=${JSON.stringify(root)}\nexec bun --install=fallback run "$RIG_DEV_REPO/src/app/cli/entrypoint.ts" "$@"\n`;
    });
    const binDirectoryOnPath = Effect.fn("DevLinkPathService.binDirectoryOnPath")(function* (
      path: string,
    ) {
      const resolved = yield* platform.resolve(path);
      for (const entry of config.pathEnvironment.split(config.pathDelimiter)) {
        if ((yield* platform.resolve(entry)) === resolved) return true;
      }
      return false;
    });
    return { repoRoot, binDirectory, shimPath, shimSource, binDirectoryOnPath } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkPathService, DevLinkPathService.make);
}

export class DevLinkStateService extends Context.Service<
  DevLinkStateService,
  {
    readonly readExisting: (path: string) => Effect.Effect<ExistingDevLinkShim, RigError>;
    readonly status: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
  }
>()("@rendotdev/rig/updates/DevLinkStateService", {
  make: Effect.gen(function* () {
    const config = yield* (yield* DevLinkConfigService).get;
    const platform = yield* DevLinkPlatformService;
    const paths = yield* DevLinkPathService;
    const readExisting = Effect.fn("DevLinkStateService.readExisting")(function* (path: string) {
      if (!(yield* platform.exists(path))) {
        return { exists: false, isRigDevShim: false, content: "" } as const;
      }
      if (!(yield* platform.isFile(path))) {
        return { exists: true, isRigDevShim: false, content: "" } as const;
      }
      const content = yield* platform.readText(path);
      return { exists: true, isRigDevShim: content.includes("Rig dev shim"), content } as const;
    });
    const status = Effect.fn("DevLinkStateService.status")(function* (
      options: DevLinkCommandOptions = {},
    ) {
      const repoRoot = yield* paths.repoRoot;
      const binDir = yield* paths.binDirectory(options.binDir);
      const shimPath = yield* paths.shimPath(binDir);
      const existing = yield* readExisting(shimPath);
      const marker =
        config.platform === "win32"
          ? `RIG_DEV_REPO=${repoRoot}`
          : `RIG_DEV_REPO=${JSON.stringify(repoRoot)}`;
      return {
        repoRoot,
        binDir,
        shimPath,
        exists: existing.exists,
        isRigDevShim: existing.isRigDevShim,
        pointsToCurrentRepo: existing.content.includes(marker),
        binDirOnPath: yield* paths.binDirectoryOnPath(binDir),
      };
    });
    return { readExisting, status } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkStateService, DevLinkStateService.make);
}

export class DevLinkMutationService extends Context.Service<
  DevLinkMutationService,
  {
    readonly link: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
    readonly unlink: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
  }
>()("@rendotdev/rig/updates/DevLinkMutationService", {
  make: Effect.gen(function* () {
    const config = yield* (yield* DevLinkConfigService).get;
    const platform = yield* DevLinkPlatformService;
    const paths = yield* DevLinkPathService;
    const state = yield* DevLinkStateService;
    const link = Effect.fn("DevLinkMutationService.link")(function* (
      options: DevLinkCommandOptions = {},
    ) {
      const repoRoot = yield* paths.repoRoot;
      const binDir = yield* paths.binDirectory(options.binDir);
      const shimPath = yield* paths.shimPath(binDir);
      const existing = yield* state.readExisting(shimPath);
      const wouldOverwriteForeignShim = existing.exists && !existing.isRigDevShim && !options.force;
      if (wouldOverwriteForeignShim) {
        return yield* new RigError({
          code: "DEV_LINK_ERROR",
          message: `Refusing to overwrite existing file: ${shimPath}`,
          details: { shimPath, hint: "Use --force to replace it." },
        });
      }
      yield* platform.makeDirectory(binDir);
      yield* platform.writeText(shimPath, yield* paths.shimSource(repoRoot));
      if (config.platform !== "win32") yield* platform.chmod(shimPath, 0o755);
      return yield* state.status(options);
    });
    const unlink = Effect.fn("DevLinkMutationService.unlink")(function* (
      options: DevLinkCommandOptions = {},
    ) {
      const binDir = yield* paths.binDirectory(options.binDir);
      const shimPath = yield* paths.shimPath(binDir);
      const existing = yield* state.readExisting(shimPath);
      const wouldRemoveForeignShim = existing.exists && !existing.isRigDevShim && !options.force;
      if (wouldRemoveForeignShim) {
        return yield* new RigError({
          code: "DEV_LINK_ERROR",
          message: `Refusing to remove non-Rig dev shim: ${shimPath}`,
          details: { shimPath, hint: "Use --force to remove it anyway." },
        });
      }
      if (existing.exists) yield* platform.remove(shimPath);
      return yield* state.status(options);
    });
    return { link, unlink } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkMutationService, DevLinkMutationService.make);
}

export class DevLinkRenderService extends Context.Service<
  DevLinkRenderService,
  {
    readonly renderLink: (status: DevLinkStatus) => Effect.Effect<string>;
    readonly renderUnlink: (status: DevLinkStatus) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/updates/DevLinkRenderService", {
  make: Effect.gen(function* () {
    const renderLink = Effect.fn("DevLinkRenderService.renderLink")(function* (
      status: DevLinkStatus,
    ) {
      const lines = [
        "Rig dev link is ready.",
        "",
        `Shim: ${status.shimPath}`,
        `Repo: ${status.repoRoot}`,
        `On PATH: ${status.binDirOnPath ? "yes" : "no"}`,
        "",
        "Try:",
        "  rig",
        "  rig list",
      ];
      if (!status.binDirOnPath) {
        lines.push("", `Add ${status.binDir} to PATH to run rig from any shell.`);
      }
      return lines.join("\n");
    });
    const renderUnlink = Effect.fn("DevLinkRenderService.renderUnlink")(function* (
      status: DevLinkStatus,
    ) {
      return ["Rig dev link removed.", "", `Shim: ${status.shimPath}`].join("\n");
    });
    return { renderLink, renderUnlink } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkRenderService, DevLinkRenderService.make);
}

const devLinkPathLayer = DevLinkPathService.layer.pipe(Layer.provide(devLinkRepositoryLayer));

const devLinkStateLayer = DevLinkStateService.layer.pipe(
  Layer.provide(Layer.merge(devLinkRepositoryLayer, devLinkPathLayer)),
);

const devLinkMutationLayer = DevLinkMutationService.layer.pipe(
  Layer.provide(Layer.mergeAll(devLinkRepositoryLayer, devLinkPathLayer, devLinkStateLayer)),
);

export const devLinkOperationsLayer = Layer.mergeAll(
  devLinkMutationLayer,
  devLinkStateLayer,
  DevLinkRenderService.layer,
);
