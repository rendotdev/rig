/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { expect, vi } from "vite-plus/test";
import { ManagedProcessConfigService, ManagedProcessService } from "./managed-process";
import {
  RigShellConfigService,
  RigShellPlatformService,
  RigShellService,
  ShellOutputService,
  ShellProcessService,
  ShellTemplateService,
  rigShellLayer,
} from "./rig-shell-service";

const templateStrings = (value: string): TemplateStringsArray =>
  Object.assign([value], { raw: [value] }) as unknown as TemplateStringsArray;

it.live("interrupts the complete child process group", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "rig-shell-interrupt-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const marker = join(directory, "should-not-exist");
      const fiber = yield* Effect.forkChild(
        RigShellService.use((service) =>
          service.bash(`(sleep 0.2; touch ${marker}) & wait`, { timeoutMs: 5_000 }),
        ).pipe(Effect.provide(rigShellLayer)),
      );
      yield* Effect.sleep("50 millis");
      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep("300 millis");
      expect(existsSync(marker)).toBe(false);
    }),
  ),
);

it.live("exposes every shell operation through the service layer", () =>
  Effect.gen(function* () {
    const shell = yield* RigShellService;
    const execResult = yield* shell.exec(["printf", "exec"]);
    const bashResult = yield* shell.bash("printf bash");
    const templateResult = yield* shell.template(templateStrings("printf template"), []);
    const jsonResult = yield* shell.json(["printf", '{"ready":true}']);
    expect(execResult.stdout).toBe("exec");
    expect(bashResult.stdout).toBe("bash");
    expect(templateResult.stdout).toBe("template");
    expect(jsonResult).toEqual({ ready: true });
  }).pipe(Effect.provide(rigShellLayer)),
);

it.live("retags template execution failures", () =>
  Effect.gen(function* () {
    const processLayer = ShellProcessService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RigShellConfigService, {
            defaults: { cwd: join(tmpdir(), "rig-missing-shell-directory") },
          }),
          RigShellPlatformService.layer,
          ManagedProcessService.layer.pipe(Layer.provide(ManagedProcessConfigService.layer)),
          ShellOutputService.layer,
        ),
      ),
    );
    const layer = RigShellService.layer.pipe(
      Layer.provide(Layer.merge(ShellTemplateService.layer, processLayer)),
    );
    const error = yield* RigShellService.use((service) =>
      service.template(templateStrings("printf unavailable"), []),
    ).pipe(Effect.provide(layer), Effect.flip);
    expect(error.operation).toBe("template");
  }),
);

it("cancels a process when its effect is interrupted", () =>
  Effect.gen(function* () {
    const stdout = new EventEmitter() as Readable;
    const stderr = new EventEmitter() as Readable;
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess & { stdout: Readable; stderr: Readable };
    const platformLayer = Layer.succeed(RigShellPlatformService, {
      environment: Effect.succeed({}),
      currentDirectory: Effect.succeed("/tmp"),
      detached: Effect.succeed(false),
      spawn: Effect.fn("RigShellPlatformService.spawn")(function* () {
        return child;
      }),
    });
    const managedLayer = ManagedProcessService.layer.pipe(
      Layer.provide(
        Layer.succeed(ManagedProcessConfigService, {
          processGroup: false,
          terminationGraceMs: 5,
        }),
      ),
    );
    const processLayer = ShellProcessService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          RigShellConfigService.layer,
          platformLayer,
          managedLayer,
          ShellOutputService.layer,
        ),
      ),
    );
    const layer = RigShellService.layer.pipe(
      Layer.provide(Layer.merge(ShellTemplateService.layer, processLayer)),
    );
    const fiber = yield* RigShellService.use((service) => service.exec(["example"])).pipe(
      Effect.provide(layer),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  }));
