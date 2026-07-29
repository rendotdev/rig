import { homedir } from "node:os";
import {
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path";
import { Context, Effect, Layer } from "effect";

export type PathOptions = { homeDir?: string };
export type RigPathsPlatform = Readonly<{
  readonly homeDirectory: Effect.Effect<string>;
  readonly workingDirectory: Effect.Effect<string>;
  readonly dirname: (pathValue: string) => Effect.Effect<string>;
  readonly isAbsolute: (pathValue: string) => Effect.Effect<boolean>;
  readonly join: (parts: readonly string[]) => Effect.Effect<string>;
  readonly resolve: (parts: readonly string[]) => Effect.Effect<string>;
}>;

export class RigPathsOptionsConfigService extends Context.Service<
  RigPathsOptionsConfigService,
  { readonly homeDir?: string }
>()("@rendotdev/rig/settings/RigPathsOptionsConfigService", {
  make: Effect.gen(function* () {
    const homeDir = process.env.RIG_HOME;
    return { homeDir } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    RigPathsOptionsConfigService,
    RigPathsOptionsConfigService.make,
  );
}

export class RigPathsPlatformService extends Context.Service<
  RigPathsPlatformService,
  {
    readonly homeDirectory: Effect.Effect<string>;
    readonly workingDirectory: Effect.Effect<string>;
    readonly dirname: (pathValue: string) => Effect.Effect<string>;
    readonly isAbsolute: (pathValue: string) => Effect.Effect<boolean>;
    readonly join: (parts: readonly string[]) => Effect.Effect<string>;
    readonly resolve: (parts: readonly string[]) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/settings/RigPathsPlatformService", {
  make: Effect.gen(function* () {
    const homeDirectory = Effect.sync(homedir).pipe(
      Effect.withSpan("RigPathsPlatformService.homeDirectory"),
    );
    const workingDirectory = Effect.sync(() => process.cwd()).pipe(
      Effect.withSpan("RigPathsPlatformService.workingDirectory"),
    );
    const dirname = Effect.fn("RigPathsPlatformService.dirname")(function* (pathValue: string) {
      return pathDirname(pathValue);
    });
    const isAbsolute = Effect.fn("RigPathsPlatformService.isAbsolute")(function* (
      pathValue: string,
    ) {
      return pathIsAbsolute(pathValue);
    });
    const join = Effect.fn("RigPathsPlatformService.join")(function* (parts: readonly string[]) {
      return pathJoin(...parts);
    });
    const resolve = Effect.fn("RigPathsPlatformService.resolve")(function* (
      parts: readonly string[],
    ) {
      return pathResolve(...parts);
    });
    return { homeDirectory, workingDirectory, dirname, isAbsolute, join, resolve } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigPathsPlatformService, RigPathsPlatformService.make);
}

export class RigPathsConfigService extends Context.Service<
  RigPathsConfigService,
  {
    readonly homeDir: string;
    readonly rigDir: string;
    readonly legacyRigDir: string;
    readonly configPath: string;
    readonly runtimeDir: string;
    readonly runtimeSdkPath: string;
    readonly runtimeTypesPath: string;
    readonly runtimeGlobalsPath: string;
    readonly runtimeToolTsconfigPath: string;
    readonly cronDir: string;
    readonly logsDir: string;
    readonly updateCheckCachePath: string;
    readonly toolMetadataCachePath: string;
    readonly migrationPromptStatePath: string;
    readonly defaultBaseRegistryDir: string;
    readonly legacyDefaultBaseRegistryDir: string;
  }
>()("@rendotdev/rig/settings/RigPathsConfigService", {
  make: Effect.gen(function* () {
    const options = yield* RigPathsOptionsConfigService;
    const platform = yield* RigPathsPlatformService;
    const homeDir = options.homeDir
      ? yield* platform.resolve([yield* platform.workingDirectory, options.homeDir])
      : yield* platform.homeDirectory;
    const rigDir = yield* platform.join([homeDir, "rig"]);
    const legacyRigDir = yield* platform.join([homeDir, ".rig"]);
    const runtimeDir = yield* platform.join([rigDir, "runtime"]);
    const configPath = yield* platform.join([rigDir, "rig.json"]);
    const runtimeSdkPath = yield* platform.join([runtimeDir, "sdk.ts"]);
    const runtimeTypesPath = yield* platform.join([runtimeDir, "types.d.ts"]);
    const runtimeGlobalsPath = yield* platform.join([runtimeDir, "globals.d.ts"]);
    const runtimeToolTsconfigPath = yield* platform.join([runtimeDir, "tsconfig.tools.json"]);
    const cronDir = yield* platform.join([rigDir, "cron"]);
    const logsDir = yield* platform.join([rigDir, ".logs"]);
    const updateCheckCachePath = yield* platform.join([rigDir, "update-check.json"]);
    const toolMetadataCachePath = yield* platform.join([rigDir, "tool-metadata.json"]);
    const migrationPromptStatePath = yield* platform.join([rigDir, "migration-prompts.json"]);
    const defaultBaseRegistryDir = "~/rig/tools";
    const legacyDefaultBaseRegistryDir = "~/.rig/tools";
    return {
      homeDir,
      rigDir,
      legacyRigDir,
      configPath,
      runtimeDir,
      runtimeSdkPath,
      runtimeTypesPath,
      runtimeGlobalsPath,
      runtimeToolTsconfigPath,
      cronDir,
      logsDir,
      updateCheckCachePath,
      toolMetadataCachePath,
      migrationPromptStatePath,
      defaultBaseRegistryDir,
      legacyDefaultBaseRegistryDir,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigPathsConfigService, RigPathsConfigService.make);
}

export class RigPathsService extends Context.Service<
  RigPathsService,
  {
    readonly expandTilde: (pathValue: string) => Effect.Effect<string>;
    readonly resolve: (pathValue: string) => Effect.Effect<string>;
    readonly cronWorkerPath: (name: string) => Effect.Effect<string>;
    readonly parentDir: (pathValue: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/settings/RigPathsService", {
  make: Effect.gen(function* () {
    const values = yield* RigPathsConfigService;
    const platform = yield* RigPathsPlatformService;
    const expand = Effect.fn("RigPathsService.expand")(function* (pathValue: string) {
      if (pathValue === "~") return values.homeDir;
      return pathValue.startsWith("~/")
        ? yield* platform.join([values.homeDir, pathValue.slice(2)])
        : pathValue;
    });
    const expandTilde = Effect.fn("RigPathsService.expandTilde")(function* (pathValue: string) {
      return yield* expand(pathValue);
    });
    const resolve = Effect.fn("RigPathsService.resolve")(function* (pathValue: string) {
      const expanded = yield* expand(pathValue);
      return (yield* platform.isAbsolute(expanded))
        ? yield* platform.resolve([expanded])
        : yield* platform.resolve([yield* platform.workingDirectory, expanded]);
    });
    const cronWorkerPath = Effect.fn("RigPathsService.cronWorkerPath")(function* (name: string) {
      return yield* platform.join([values.cronDir, `${name}.ts`]);
    });
    const parentDir = Effect.fn("RigPathsService.parentDir")(function* (pathValue: string) {
      return yield* platform.dirname(pathValue);
    });
    return { expandTilde, resolve, cronWorkerPath, parentDir } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigPathsService, RigPathsService.make);
}

const rigPathsLiveDependenciesLayer = Layer.merge(
  RigPathsOptionsConfigService.layer,
  RigPathsPlatformService.layer,
);
export const rigPathsConfigLayer: Layer.Layer<
  RigPathsConfigService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = RigPathsConfigService.layer;
export const rigPathsConfigLiveLayer: Layer.Layer<RigPathsConfigService> = rigPathsConfigLayer.pipe(
  Layer.provide(rigPathsLiveDependenciesLayer),
);
const rigPathsServiceLayer = RigPathsService.layer.pipe(Layer.provide(rigPathsConfigLayer));
export const rigPathsLayer: Layer.Layer<
  RigPathsConfigService | RigPathsService,
  never,
  RigPathsOptionsConfigService | RigPathsPlatformService
> = Layer.merge(rigPathsConfigLayer, rigPathsServiceLayer);
