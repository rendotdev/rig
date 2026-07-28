/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { FileLockService } from "./file-lock";

it.live("runs file operations through the service layer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "rig-file-lock-effect-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const locks = yield* FileLockService;
      const result = yield* locks.withLock({
        targetPath: join(directory, "state.json"),
        operation: () => "locked",
      });

      expect(result).toBe("locked");
    }),
  ).pipe(Effect.provide(FileLockService.layer)),
);
