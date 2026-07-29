import type { ChildProcess } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";

const TERMINATION_GRACE_MS = 100;

export type ManagedProcessResult = Readonly<{
  exitCode: number;
  exitCodeKnown: boolean;
  signal: NodeJS.Signals | null;
}>;

export class ManagedProcessError extends Schema.TaggedErrorClass<ManagedProcessError>()(
  "ManagedProcessError",
  {
    command: Schema.Array(Schema.String),
    reason: Schema.Literals(["spawn", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ManagedProcessConfigService extends Context.Service<
  ManagedProcessConfigService,
  {
    readonly processGroup: boolean;
    readonly terminationGraceMs: number;
  }
>()("@rendotdev/rig/runtime/ManagedProcessConfigService", {
  make: Effect.succeed({
    processGroup: process.platform !== "win32",
    terminationGraceMs: TERMINATION_GRACE_MS,
  }),
}) {
  static readonly layer = Layer.effect(
    ManagedProcessConfigService,
    ManagedProcessConfigService.make,
  );
}

export class ManagedProcessService extends Context.Service<
  ManagedProcessService,
  {
    readonly wait: (params: {
      readonly child: ChildProcess;
      readonly command: string[];
      readonly timeoutMs: number;
    }) => Effect.Effect<ManagedProcessResult, ManagedProcessError>;
  }
>()("@rendotdev/rig/runtime/ManagedProcessService", {
  make: Effect.gen(function* () {
    const config = yield* ManagedProcessConfigService;

    const wait = Effect.fn("ManagedProcessService.wait")(function* (params: {
      readonly child: ChildProcess;
      readonly command: string[];
      readonly timeoutMs: number;
    }) {
      return yield* Effect.callback<ManagedProcessResult, ManagedProcessError>((resume) => {
        let closed = false,
          timedOut = false;
        let spawnCause: unknown;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let escalation: ReturnType<typeof setTimeout> | undefined;

        const signal = (value: NodeJS.Signals) => {
          try {
            const canSignalProcessGroup = config.processGroup && params.child.pid;
            if (canSignalProcessGroup) process.kill(-params.child.pid, value);
            else params.child.kill(value);
          } catch {
            return;
          }
        };
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (escalation) clearTimeout(escalation);
        };
        const terminate = (fromTimeout: boolean) => {
          if (closed) return;
          timedOut = fromTimeout;
          signal("SIGTERM");
          escalation = setTimeout(() => signal("SIGKILL"), config.terminationGraceMs);
        };
        const onError = (cause: unknown) => void (spawnCause = cause);
        const onClose = (code: number | null, signalValue: NodeJS.Signals | null) => {
          closed = true;
          clearTimers();
          if (spawnCause) {
            resume(
              Effect.fail(
                new ManagedProcessError({
                  command: params.command,
                  reason: "spawn",
                  cause: spawnCause,
                }),
              ),
            );
          } else if (timedOut) {
            resume(
              Effect.fail(
                new ManagedProcessError({
                  command: params.command,
                  reason: "timeout",
                  cause: new Error(`Command timed out after ${params.timeoutMs}ms.`),
                }),
              ),
            );
          } else {
            resume(
              Effect.succeed({
                exitCode: code ?? 1,
                exitCodeKnown: code !== null,
                signal: signalValue,
              }),
            );
          }
        };

        params.child.once("error", onError);
        params.child.once("close", onClose);
        timeout = setTimeout(() => terminate(true), params.timeoutMs);

        return Effect.sync(() => {
          params.child.removeListener("error", onError);
          params.child.removeListener("close", onClose);
          if (timeout) clearTimeout(timeout);
          terminate(false);
        });
      });
    });

    return { wait } as const;
  }),
}) {
  static readonly layer = Layer.effect(ManagedProcessService, ManagedProcessService.make);
}

export const managedProcessLayer = ManagedProcessService.layer.pipe(
  Layer.provide(ManagedProcessConfigService.layer),
);
