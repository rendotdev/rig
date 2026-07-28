import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RigConfig } from "../../domains/settings/types/config-schema.ts";
import { RigConfigStoreService, type RigConfigMutator } from "./config-store";

export const RigConfigOperation = Schema.Literals([
  "acknowledgeMigration",
  "ensure",
  "read",
  "write",
  "update",
]);
export type RigConfigOperation = typeof RigConfigOperation.Type;

export class RigConfigError extends Schema.TaggedErrorClass<RigConfigError>()("RigConfigError", {
  operation: RigConfigOperation,
  cause: Schema.Defect(),
}) {}

export type RigConfigServiceImplementation = {
  acknowledgeMigrationPrompt(params: {}): Promise<void>;
  ensure(params: {}): Promise<RigConfig>;
  read(params: {}): Promise<RigConfig>;
  write(params: { config: RigConfig }): Promise<void>;
  update(params: { mutator: RigConfigMutator }): Promise<RigConfig>;
};

type RigConfigServiceShape = Readonly<{
  acknowledgeMigrationPrompt: Effect.Effect<void, RigConfigError>;
  ensure: Effect.Effect<RigConfig, RigConfigError>;
  read: Effect.Effect<RigConfig, RigConfigError>;
  write: (config: RigConfig) => Effect.Effect<void, RigConfigError>;
  update: (mutator: RigConfigMutator) => Effect.Effect<RigConfig, RigConfigError>;
}>;

export class RigConfigService extends Context.Service<RigConfigService, RigConfigServiceShape>()(
  "@rendotdev/rig/settings/RigConfigService",
) {
  public static readonly makeLayer = (
    implementation: RigConfigServiceImplementation,
  ): Layer.Layer<RigConfigService> => {
    const attempt = <Result>(
      operation: RigConfigOperation,
      run: () => Promise<Result>,
    ): Effect.Effect<Result, RigConfigError> =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new RigConfigError({ operation, cause }),
      }).pipe(Effect.withSpan(`RigConfigService.${operation}`));

    return Layer.succeed(RigConfigService, {
      acknowledgeMigrationPrompt: attempt("acknowledgeMigration", () =>
        implementation.acknowledgeMigrationPrompt({}),
      ),
      ensure: attempt("ensure", () => implementation.ensure({})),
      read: attempt("read", () => implementation.read({})),
      write: (config) => attempt("write", () => implementation.write({ config })),
      update: (mutator) => attempt("update", () => implementation.update({ mutator })),
    });
  };

  public static readonly layer = RigConfigService.makeLayer(new RigConfigStoreService());
}
