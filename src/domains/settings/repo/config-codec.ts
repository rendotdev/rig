import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { RigConfigSchema, type RigConfig } from "../types/config-schema";

export class RigConfigCodecService extends Context.Service<
  RigConfigCodecService,
  {
    readonly decode: (raw: string, path: string) => Effect.Effect<RigConfig, RigError>;
    readonly validate: (config: RigConfig) => Effect.Effect<RigConfig, RigError>;
  }
>()("@rendotdev/rig/settings/RigConfigCodecService", {
  make: Effect.gen(function* () {
    const decode = Effect.fn("RigConfigCodecService.decode")(function* (raw: string, path: string) {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (error) =>
          new RigError({
            code: "CONFIG_INVALID",
            message: `Config is not valid JSON at ${path}.`,
            details: { error },
          }),
      });
      const result = RigConfigSchema.safeParse(parsed);
      if (result.success) return result.data;
      return yield* new RigError({
        code: "CONFIG_INVALID",
        message: "Rig config is invalid.",
        details: result.error.flatten(),
      });
    });
    const validate = Effect.fn("RigConfigCodecService.validate")(function* (config: RigConfig) {
      const result = RigConfigSchema.safeParse(config);
      if (result.success) return result.data;
      return yield* new RigError({
        code: "CONFIG_INVALID",
        message: "Rig config is invalid.",
        details: result.error.flatten(),
      });
    });
    return { decode, validate } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigConfigCodecService, RigConfigCodecService.make);
}

export const rigConfigCodecLayer = RigConfigCodecService.layer;
