import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../errors/rig-error";

export type DatabaseConstructor = new (
  filename: string,
  options?: { create?: boolean; strict?: boolean },
) => Database;

export class SqlitePlatformService extends Context.Service<
  SqlitePlatformService,
  {
    readonly available: Effect.Effect<boolean>;
    readonly load: Effect.Effect<DatabaseConstructor, RigError>;
  }
>()("@rendotdev/rig/providers/database/SqlitePlatformService", {
  make: Effect.gen(function* () {
    const toRigError = (error: unknown) => {
      if (error instanceof RigError) return error;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    };
    const testDatabase = () =>
      (globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: DatabaseConstructor })
        .rigSqliteDatabaseForTests;
    const available = Effect.sync(() =>
      Boolean(testDatabase() || typeof process.versions.bun === "string"),
    ).pipe(Effect.withSpan("SqlitePlatformService.available"));
    const load = Effect.gen(function* () {
      const injected = testDatabase();
      if (injected) return injected;
      return yield* Effect.tryPromise({
        /* v8 ignore start -- Bun's native module is exercised by packaged integration */
        try: async () => {
          const moduleValue = (await import("bun:sqlite")) as { Database: DatabaseConstructor };
          return moduleValue.Database;
        },
        /* v8 ignore stop */
        catch: toRigError,
      });
    }).pipe(Effect.withSpan("SqlitePlatformService.load"));
    return { available, load } as const;
  }),
}) {
  static readonly layer = Layer.effect(SqlitePlatformService, SqlitePlatformService.make);
}
