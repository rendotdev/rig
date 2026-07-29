import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../providers/errors/rig-error";

type BunRuntimeSpawnOptions = Parameters<typeof spawnSync>[2];

export class RuntimeBootstrapConfigService extends Context.Service<
  RuntimeBootstrapConfigService,
  { readonly env: NodeJS.ProcessEnv }
>()("@rendotdev/rig/application/RuntimeBootstrapConfigService", {
  make: Effect.sync(() => ({ env: process.env })),
}) {
  static readonly layer = Layer.effect(
    RuntimeBootstrapConfigService,
    RuntimeBootstrapConfigService.make,
  );
}

export class RuntimeBootstrapPlatformService extends Context.Service<
  RuntimeBootstrapPlatformService,
  {
    readonly spawn: (
      command: string,
      args: string[],
      options: BunRuntimeSpawnOptions,
    ) => Effect.Effect<SpawnSyncReturns<string | Buffer>, RigError>;
    readonly bunGlobal: Effect.Effect<unknown>;
    readonly realpath: (path: string) => Effect.Effect<string, RigError>;
    readonly pathToFileUrl: (path: string) => Effect.Effect<URL>;
  }
>()("@rendotdev/rig/application/RuntimeBootstrapPlatformService", {
  make: Effect.gen(function* () {
    const normalizeError = (cause: unknown): RigError => {
      if (cause instanceof RigError) return cause;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    };
    const spawn = Effect.fn("RuntimeBootstrapPlatformService.spawn")(function* (
      command: string,
      args: string[],
      options: BunRuntimeSpawnOptions,
    ) {
      return yield* Effect.try({
        try: () => spawnSync(command, args, options),
        catch: normalizeError,
      });
    });
    const bunGlobal = Effect.sync(
      () => (globalThis as typeof globalThis & { Bun?: unknown }).Bun,
    ).pipe(Effect.withSpan("RuntimeBootstrapPlatformService.bunGlobal"));
    const realpath = Effect.fn("RuntimeBootstrapPlatformService.realpath")(function* (
      path: string,
    ) {
      return yield* Effect.try({ try: () => realpathSync(path), catch: normalizeError });
    });
    const pathToFileUrl = Effect.fn("RuntimeBootstrapPlatformService.pathToFileUrl")(function* (
      path: string,
    ) {
      return pathToFileURL(path);
    });
    return { spawn, bunGlobal, realpath, pathToFileUrl } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    RuntimeBootstrapPlatformService,
    RuntimeBootstrapPlatformService.make,
  );
}

export class RuntimeBootstrapService extends Context.Service<
  RuntimeBootstrapService,
  {
    readonly run: (params: {
      metaUrl: string;
      argv: string[];
    }) => Effect.Effect<number | undefined, RigError>;
    readonly shouldBootstrap: Effect.Effect<boolean>;
    readonly resolveBunPath: Effect.Effect<string>;
    readonly autoInstallFlag: Effect.Effect<string>;
    readonly isEntrypoint: (metaUrl: string, argvPath?: string) => Effect.Effect<boolean>;
  }
>()("@rendotdev/rig/application/RuntimeBootstrapService", {
  make: Effect.gen(function* () {
    const config = yield* RuntimeBootstrapConfigService;
    const platform = yield* RuntimeBootstrapPlatformService;

    const shouldBootstrap = Effect.gen(function* () {
      const bunGlobal = yield* platform.bunGlobal;
      return (
        bunGlobal === undefined &&
        config.env.RIG_BUN_BOOTSTRAPPED !== "1" &&
        config.env.RIG_DISABLE_BUN_BOOTSTRAP !== "1"
      );
    }).pipe(Effect.withSpan("RuntimeBootstrapService.shouldBootstrap"));

    const resolveBunPath = Effect.succeed(config.env.RIG_BUN_PATH ?? "bun").pipe(
      Effect.withSpan("RuntimeBootstrapService.resolveBunPath"),
    );

    const autoInstallFlag = Effect.succeed("--install=fallback").pipe(
      Effect.withSpan("RuntimeBootstrapService.autoInstallFlag"),
    );

    const isEntrypoint = Effect.fn("RuntimeBootstrapService.isEntrypoint")(function* (
      metaUrl: string,
      argvPath?: string,
    ) {
      const targetPath = argvPath ?? process.argv[1];
      if (!targetPath) return false;
      const canonicalPath = yield* platform
        .realpath(targetPath)
        .pipe(Effect.orElseSucceed(() => targetPath));
      return metaUrl === (yield* platform.pathToFileUrl(canonicalPath)).href;
    });

    const run = Effect.fn("RuntimeBootstrapService.run")(function* (params: {
      metaUrl: string;
      argv: string[];
    }) {
      if (!(yield* shouldBootstrap)) return undefined;
      const bunPath = yield* resolveBunPath;
      const flag = yield* autoInstallFlag;
      const result = yield* platform.spawn(
        bunPath,
        [flag, fileURLToPath(params.metaUrl), ...params.argv.slice(2)],
        {
          stdio: "inherit",
          env: { ...config.env, RIG_BUN_BOOTSTRAPPED: "1" },
        },
      );
      return result.status ?? 1;
    });

    return { run, shouldBootstrap, resolveBunPath, autoInstallFlag, isEntrypoint } as const;
  }),
}) {
  static readonly layer = Layer.effect(RuntimeBootstrapService, RuntimeBootstrapService.make);
}

export const runtimeBootstrapLayer = RuntimeBootstrapService.layer.pipe(
  Layer.provide(
    Layer.merge(RuntimeBootstrapConfigService.layer, RuntimeBootstrapPlatformService.layer),
  ),
);
