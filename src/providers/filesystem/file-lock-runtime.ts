import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Context, Effect, Layer, Schema } from "effect";

export class FileLockRuntimeError extends Schema.TaggedErrorClass<FileLockRuntimeError>()(
  "FileLockRuntimeError",
  { cause: Schema.Defect() },
) {}

export class FileLockRuntimeService extends Context.Service<
  FileLockRuntimeService,
  {
    readonly killProcess: (
      pid: number,
      signal: number,
    ) => Effect.Effect<void, FileLockRuntimeError>;
    readonly sleep: (milliseconds: number) => Effect.Effect<void>;
    readonly randomUuid: Effect.Effect<string>;
    readonly hostName: Effect.Effect<string>;
    readonly processPid: Effect.Effect<number>;
    readonly now: Effect.Effect<number>;
    readonly timestamp: Effect.Effect<string>;
  }
>()("@rendotdev/rig/settings/FileLockRuntimeService", {
  make: Effect.gen(function* () {
    const killProcess = Effect.fn("FileLockRuntimeService.killProcess")(function* (
      pid: number,
      signal: number,
    ) {
      yield* Effect.try({
        try: () => process.kill(pid, signal),
        catch: (cause) => new FileLockRuntimeError({ cause }),
      });
    });
    const sleep = Effect.fn("FileLockRuntimeService.sleep")(function* (milliseconds: number) {
      yield* Effect.sleep(milliseconds);
    });
    const randomUuid = Effect.sync(randomUUID).pipe(
      Effect.withSpan("FileLockRuntimeService.randomUuid"),
    );
    const hostName = Effect.sync(hostname).pipe(Effect.withSpan("FileLockRuntimeService.hostName"));
    const processPid = Effect.sync(() => process.pid).pipe(
      Effect.withSpan("FileLockRuntimeService.processPid"),
    );
    const now = Effect.sync(Date.now).pipe(Effect.withSpan("FileLockRuntimeService.now"));
    const timestamp = Effect.sync(() => new Date().toISOString()).pipe(
      Effect.withSpan("FileLockRuntimeService.timestamp"),
    );
    return { killProcess, sleep, randomUuid, hostName, processPid, now, timestamp } as const;
  }),
}) {
  static readonly layer = Layer.effect(FileLockRuntimeService, FileLockRuntimeService.make);
}
