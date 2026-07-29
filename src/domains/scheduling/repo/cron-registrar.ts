import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";

type BunCronApi = {
  (path: string, schedule: string, title: string): Promise<void>;
  parse(expression: string): Date | null;
  remove(title: string): Promise<void>;
};

export class CronRegistrarService extends Context.Service<
  CronRegistrarService,
  {
    readonly register: (params: {
      readonly path: string;
      readonly schedule: string;
      readonly title: string;
    }) => Effect.Effect<void, RigError>;
    readonly remove: (title: string) => Effect.Effect<void, RigError>;
    readonly validate: (schedule: string) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/scheduling/CronRegistrarService", {
  make: Effect.gen(function* () {
    const getCron = () => {
      const cron = (globalThis as typeof globalThis & { Bun?: { cron?: unknown } }).Bun?.cron;
      if (typeof cron === "function") return cron as BunCronApi;
      throw new RigError({
        code: "CRON_ERROR",
        message: "Bun cron is unavailable. Run rig with Bun.",
      });
    };
    const mapError = (cause: unknown) =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "CRON_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const register = Effect.fn("CronRegistrarService.register")(function* (params: {
      readonly path: string;
      readonly schedule: string;
      readonly title: string;
    }) {
      yield* Effect.tryPromise({
        try: () => getCron()(params.path, params.schedule, params.title),
        catch: mapError,
      });
    });
    const remove = Effect.fn("CronRegistrarService.remove")(function* (title: string) {
      yield* Effect.tryPromise({ try: () => getCron().remove(title), catch: mapError });
    });
    const validate = Effect.fn("CronRegistrarService.validate")(function* (schedule: string) {
      yield* Effect.try({
        try: () => {
          if (!getCron().parse(schedule)) {
            throw new RigError({
              code: "CRON_ERROR",
              message: `Cron schedule has no future runs: ${schedule}`,
            });
          }
        },
        catch: mapError,
      });
    });
    return { register, remove, validate } as const;
  }),
}) {
  static readonly layer = Layer.effect(CronRegistrarService, CronRegistrarService.make);
}

export const cronRegistrarLayer = CronRegistrarService.layer;
