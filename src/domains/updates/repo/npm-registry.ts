import { Context, Effect, Layer, Schema } from "effect";
import { NpmRegistryError, NpmRegistryResponse, NpmRegistryResponseError } from "../types/updates";

export class NpmRegistryPlatformService extends Context.Service<
  NpmRegistryPlatformService,
  {
    readonly fetchJson: (
      url: string,
    ) => Effect.Effect<
      { readonly ok: boolean; readonly status: number; readonly data: unknown },
      NpmRegistryError
    >;
  }
>()("@rendotdev/rig/updates/NpmRegistryPlatformService", {
  make: Effect.gen(function* () {
    const fetchJson = Effect.fn("NpmRegistryPlatformService.fetchJson")(function* (url: string) {
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, { signal });
          const data = response.ok ? await response.json() : undefined;
          return { ok: response.ok, status: response.status, data } as const;
        },
        catch: (cause) => new NpmRegistryError({ cause }),
      });
    });
    return { fetchJson } as const;
  }),
}) {
  static readonly layer = Layer.effect(NpmRegistryPlatformService, NpmRegistryPlatformService.make);
}

export class NpmRegistryService extends Context.Service<
  NpmRegistryService,
  {
    readonly latestVersion: (
      packageName: string,
      timeoutMs: number,
    ) => Effect.Effect<string | undefined, NpmRegistryError>;
  }
>()("@rendotdev/rig/updates/NpmRegistryService", {
  make: Effect.gen(function* () {
    const platform = yield* NpmRegistryPlatformService;
    const latestVersion = Effect.fn("NpmRegistryService.latestVersion")(function* (
      packageName: string,
      timeoutMs: number,
    ) {
      const response = yield* platform
        .fetchJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
        .pipe(
          Effect.timeout(timeoutMs),
          Effect.mapError((cause) =>
            cause instanceof NpmRegistryError ? cause : new NpmRegistryError({ cause }),
          ),
        );
      if (!response.ok) {
        const isTransientResponse =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (isTransientResponse) {
          return yield* new NpmRegistryError({
            cause: new NpmRegistryResponseError({ status: response.status }),
          });
        }
        return undefined;
      }
      const value = yield* Schema.decodeUnknownEffect(NpmRegistryResponse)(response.data).pipe(
        Effect.mapError((cause) => new NpmRegistryError({ cause })),
      );
      return value.version;
    });
    return { latestVersion } as const;
  }),
}) {
  static readonly layer = Layer.effect(NpmRegistryService, NpmRegistryService.make);
}

export const npmRegistryLayer = NpmRegistryService.layer.pipe(
  Layer.provide(NpmRegistryPlatformService.layer),
);
