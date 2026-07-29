/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { expect, vi } from "vite-plus/test";
import {
  ManagedProcessConfigService,
  ManagedProcessService,
  managedProcessLayer,
} from "./managed-process";

it("resolves with the child exit code", () =>
  Effect.gen(function* () {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const result = yield* ManagedProcessService.use((service) =>
      service.wait({ child, command: ["example"], timeoutMs: 1_000 }),
    ).pipe(
      Effect.tap(() => Effect.void),
      Effect.provide(managedProcessLayer),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    child.emit("close", 7);
    expect(yield* Fiber.join(result)).toEqual({
      exitCode: 7,
      exitCodeKnown: true,
      signal: null,
    });
  }));

it("terminates and escalates an interrupted child", () =>
  Effect.gen(function* () {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 42 });
    child.kill = vi.fn(() => true);
    const layer = ManagedProcessService.layer.pipe(
      Layer.provide(
        Layer.succeed(ManagedProcessConfigService, {
          processGroup: false,
          terminationGraceMs: 5,
        }),
      ),
    );
    const fiber = yield* ManagedProcessService.use((service) =>
      service.wait({ child, command: ["example"], timeoutMs: 1_000 }),
    ).pipe(Effect.provide(layer), Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    yield* Effect.sleep("20 millis");
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  }));

it("keeps a useful error message when a process times out", () =>
  Effect.gen(function* () {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const fiber = yield* ManagedProcessService.use((service) =>
      service.wait({ child, command: ["example"], timeoutMs: 1 }),
    ).pipe(Effect.provide(managedProcessLayer), Effect.forkChild);
    yield* Effect.sleep("5 millis");
    child.emit("close", null, "SIGTERM");
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);

    expect(error.reason).toBe("timeout");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("Command timed out after 1ms.");
  }));
