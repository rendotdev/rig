/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, vi } from "vite-plus/test";
import { makeRigShellLayer, RigShellLayer, RigShellService } from "./rig-shell-service";
import { BunRigShellProvider } from "./shell";

function templateStrings(value: string): TemplateStringsArray {
  return Object.assign([value], { raw: [value] }) as unknown as TemplateStringsArray;
}

it.live("interrupts the complete child process group", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "rig-shell-interrupt-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const marker = join(directory, "should-not-exist");
      const shell = new BunRigShellProvider();
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const service = yield* RigShellService;
          return yield* service.bash(`(sleep 0.2; touch ${marker}) & wait`, {
            timeoutMs: 5_000,
          });
        }).pipe(Effect.provide(makeRigShellLayer(shell))),
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
  }).pipe(Effect.provide(RigShellLayer)),
);

it.live("retags template execution failures", () =>
  Effect.gen(function* () {
    const shell = new BunRigShellProvider({
      params: { cwd: join(tmpdir(), "rig-missing-shell-directory") },
      deps: BunRigShellProvider.defaultConstruction.deps,
    });
    const error = yield* Effect.gen(function* () {
      const service = yield* RigShellService;
      return yield* service.template(templateStrings("printf unavailable"), []);
    }).pipe(Effect.provide(makeRigShellLayer(shell)), Effect.flip);

    expect(error.operation).toBe("template");
  }),
);

it("cancels a process when its signal was already aborted", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout, stderr }) as ChildProcess;
  const cancel = vi.fn();
  const shell = new BunRigShellProvider({
    params: {},
    deps: {
      ...BunRigShellProvider.defaultConstruction.deps,
      spawn: (() => child) as typeof BunRigShellProvider.defaultConstruction.deps.spawn,
      createManagedProcess: () => ({ wait: async () => 0, cancel }),
    },
  });
  const controller = new AbortController();
  controller.abort();
  await shell.execWithSignal({ args: ["example"], signal: controller.signal });

  expect(cancel).toHaveBeenCalledOnce();
});
