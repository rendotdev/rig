import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CronStateError } from "../types/cron";

export class CronWorkerRepositoryService extends Context.Service<
  CronWorkerRepositoryService,
  {
    readonly read: (path: string) => Effect.Effect<string | undefined, CronStateError>;
    readonly write: (path: string, source: string) => Effect.Effect<void, CronStateError>;
    readonly remove: (path: string) => Effect.Effect<void, CronStateError>;
  }
>()("@rendotdev/rig/scheduling/CronWorkerRepositoryService", {
  make: Effect.gen(function* () {
    const errorCode = (cause: unknown) =>
      typeof cause === "object" && cause !== null && "code" in cause
        ? String(cause.code)
        : undefined;
    const read = Effect.fn("CronWorkerRepositoryService.read")(function* (path: string) {
      return yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => new CronStateError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          errorCode(error.cause) === "ENOENT"
            ? Effect.as(Effect.void, undefined as string | undefined)
            : Effect.fail(error),
        ),
      );
    });
    const write = Effect.fn("CronWorkerRepositoryService.write")(function* (
      path: string,
      source: string,
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, source, "utf8");
        },
        catch: (cause) => new CronStateError({ cause }),
      });
    });
    const remove = Effect.fn("CronWorkerRepositoryService.remove")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => rm(path, { force: true }),
        catch: (cause) => new CronStateError({ cause }),
      });
    });
    return { read, write, remove } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CronWorkerRepositoryService,
    CronWorkerRepositoryService.make,
  );
}

export const cronWorkerRepositoryLayer = CronWorkerRepositoryService.layer;
