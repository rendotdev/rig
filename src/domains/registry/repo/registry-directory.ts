import { mkdir } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";

export class RegistryDirectoryRepositoryService extends Context.Service<
  RegistryDirectoryRepositoryService,
  { readonly ensure: (path: string) => Effect.Effect<void, RigError> }
>()("@rendotdev/rig/registry/RegistryDirectoryRepositoryService", {
  make: Effect.gen(function* () {
    const ensure = Effect.fn("RegistryDirectoryRepositoryService.ensure")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => mkdir(path, { recursive: true }),
        catch: (cause) =>
          new RigError({
            code: "CONFIG_INVALID",
            message: "Could not create the registry directory.",
            details: { path, cause },
          }),
      });
    });
    return { ensure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    RegistryDirectoryRepositoryService,
    RegistryDirectoryRepositoryService.make,
  );
}

export const registryDirectoryRepositoryLayer = RegistryDirectoryRepositoryService.layer;
