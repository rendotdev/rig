import { existsSync, realpathSync } from "node:fs";
import {
  basename as pathBasename,
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer, Option } from "effect";

export type PackageRootDependencies = Readonly<{
  getEnvironmentRoot: () => string | undefined;
  getArgvEntrypoint: () => string | undefined;
  getExecPath: () => string;
  exists: (pathValue: string) => boolean;
  realpath: (pathValue: string) => string;
  basename: (pathValue: string) => string;
  dirname: (pathValue: string) => string;
  join: (...parts: string[]) => string;
  resolve: (pathValue: string) => string;
  fileURLToPath: (metaUrl: string) => string;
}>;

export class PackageRootPlatformService extends Context.Service<
  PackageRootPlatformService,
  {
    readonly environmentRoot: Effect.Effect<string | undefined>;
    readonly argvEntrypoint: Effect.Effect<string | undefined>;
    readonly execPath: Effect.Effect<string>;
    readonly exists: (pathValue: string) => Effect.Effect<boolean>;
    readonly realpath: (pathValue: string) => Effect.Effect<string, unknown>;
    readonly basename: (pathValue: string) => Effect.Effect<string>;
    readonly dirname: (pathValue: string) => Effect.Effect<string>;
    readonly join: (parts: string[]) => Effect.Effect<string>;
    readonly resolve: (pathValue: string) => Effect.Effect<string>;
    readonly fileUrlToPath: (metaUrl: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/runtime/PackageRootPlatformService", {
  make: Effect.gen(function* () {
    const environmentRoot = Effect.sync(() => process.env.RIG_PACKAGE_ROOT).pipe(
      Effect.withSpan("PackageRootPlatformService.environmentRoot"),
    );
    const argvEntrypoint = Effect.sync(() => process.argv[1]).pipe(
      Effect.withSpan("PackageRootPlatformService.argvEntrypoint"),
    );
    const execPath = Effect.sync(() => process.execPath).pipe(
      Effect.withSpan("PackageRootPlatformService.execPath"),
    );
    const exists = Effect.fn("PackageRootPlatformService.exists")(function* (pathValue: string) {
      return existsSync(pathValue);
    });
    const realpath = Effect.fn("PackageRootPlatformService.realpath")(function* (
      pathValue: string,
    ) {
      return yield* Effect.try(() => realpathSync(pathValue));
    });
    const basename = Effect.fn("PackageRootPlatformService.basename")(function* (
      pathValue: string,
    ) {
      return pathBasename(pathValue);
    });
    const dirname = Effect.fn("PackageRootPlatformService.dirname")(function* (pathValue: string) {
      return pathDirname(pathValue);
    });
    const join = Effect.fn("PackageRootPlatformService.join")(function* (parts: string[]) {
      return pathJoin(...parts);
    });
    const resolve = Effect.fn("PackageRootPlatformService.resolve")(function* (pathValue: string) {
      return pathResolve(pathValue);
    });
    const fileUrlToPath = Effect.fn("PackageRootPlatformService.fileUrlToPath")(function* (
      metaUrl: string,
    ) {
      return fileURLToPath(metaUrl);
    });
    return {
      environmentRoot,
      argvEntrypoint,
      execPath,
      exists,
      realpath,
      basename,
      dirname,
      join,
      resolve,
      fileUrlToPath,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(PackageRootPlatformService, PackageRootPlatformService.make);
}

export class PackageRootService extends Context.Service<
  PackageRootService,
  {
    readonly fromEntrypoint: (entrypoint: string | undefined) => Effect.Effect<string | undefined>;
    readonly fromModule: (metaUrl: string) => Effect.Effect<string | undefined>;
    readonly find: (metaUrl: string) => Effect.Effect<string>;
    readonly packageFile: (metaUrl: string, ...parts: string[]) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/runtime/PackageRootService", {
  make: Effect.gen(function* () {
    const platform = yield* PackageRootPlatformService;

    const isBunBinary = (metaUrl: string) =>
      metaUrl.includes("$bunfs") || metaUrl.includes("~BUN") || metaUrl.includes("%7EBUN");

    const safeRealpath = Effect.fn("PackageRootService.safeRealpath")(function* (
      pathValue: string,
    ) {
      const resolved = yield* Effect.option(platform.realpath(pathValue));
      if (Option.isSome(resolved)) return resolved.value;
      const absolute = yield* platform.resolve(pathValue);
      /* v8 ignore next */
      return (yield* platform.exists(absolute)) ? absolute : undefined;
    });

    const fromEntrypoint = Effect.fn("PackageRootService.fromEntrypoint")(function* (
      entrypoint: string | undefined,
    ) {
      if (!entrypoint) return undefined;
      const resolved = yield* safeRealpath(entrypoint);
      if (!resolved) return undefined;
      const parent = yield* platform.dirname(resolved);
      const parentName = yield* platform.basename(parent);
      return parentName === "src" || parentName === "dist"
        ? yield* platform.dirname(parent)
        : undefined;
    });

    const fromModule = Effect.fn("PackageRootService.fromModule")(function* (metaUrl: string) {
      let current = yield* platform.dirname(yield* platform.fileUrlToPath(metaUrl));
      for (let depth = 0; depth < 8; depth += 1) {
        if (yield* platform.exists(yield* platform.join([current, "package.json"]))) return current;
        const parent = yield* platform.dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
      return undefined;
    });

    const find = Effect.fn("PackageRootService.find")(function* (metaUrl: string) {
      const environmentRoot = yield* platform.environmentRoot;
      if (environmentRoot) return yield* platform.resolve(environmentRoot);
      const argvRoot = yield* fromEntrypoint(yield* platform.argvEntrypoint);
      if (argvRoot) return argvRoot;
      const executable = yield* platform.execPath;
      const execRoot = yield* fromEntrypoint(executable);
      if (execRoot) return execRoot;
      if (isBunBinary(metaUrl)) return yield* platform.dirname(executable);
      const moduleRoot = yield* fromModule(metaUrl);
      if (moduleRoot) return moduleRoot;
      return yield* platform.join([
        yield* platform.dirname(yield* platform.fileUrlToPath(metaUrl)),
        "..",
        "..",
      ]);
    });

    const packageFile = Effect.fn("PackageRootService.packageFile")(function* (
      metaUrl: string,
      ...parts: string[]
    ) {
      return yield* platform.join([yield* find(metaUrl), ...parts]);
    });

    return { fromEntrypoint, fromModule, find, packageFile } as const;
  }),
}) {
  static readonly layer = Layer.effect(PackageRootService, PackageRootService.make);
}

export const packageRootLayer = PackageRootService.layer.pipe(
  Layer.provide(PackageRootPlatformService.layer),
);
