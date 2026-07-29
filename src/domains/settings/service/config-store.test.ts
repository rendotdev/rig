/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vite-plus/test";
import { RigConfigError } from "../types/config-error";
import type { RigConfig } from "../types/config-schema";
import { RigConfigStoreService } from "./config-store";

const initial: RigConfig = {
  version: 1,
  baseRegistryDir: "~/rig/tools",
  customRegistries: [],
  cronJobs: [],
};

it.effect("supports replacement with a test layer", () => {
  let stored = initial;
  const layer = Layer.succeed(RigConfigStoreService, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    migrationResult: Effect.succeed(undefined),
    acknowledgeMigrationPrompt: Effect.void,
    ensure: Effect.sync(() => stored),
    read: Effect.sync(() => stored),
    write: (config) => Effect.sync(() => void (stored = config)),
    update: (mutator) =>
      Effect.promise(() => Promise.resolve(mutator(stored))).pipe(
        Effect.tap((config) => Effect.sync(() => void (stored = config))),
      ),
  });

  return Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    yield* config.write({ ...stored, customRegistries: ["written"] });
    expect((yield* config.update((current) => current)).customRegistries).toEqual(["written"]);
  }).pipe(Effect.provide(layer));
});

it.effect("retains failures in the typed error channel", () => {
  const failure = new Error("config unavailable");
  const error = new RigConfigError({ operation: "ensure", cause: failure });
  const layer = Layer.succeed(RigConfigStoreService, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    migrationResult: Effect.succeed(undefined),
    acknowledgeMigrationPrompt: Effect.void,
    ensure: Effect.fail(error),
    read: Effect.fail(error),
    write: () => Effect.fail(error),
    update: () => Effect.fail(error),
  });

  return Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const received = yield* config.ensure.pipe(Effect.flip);
    expect(received.operation).toBe("ensure");
    expect(received.cause).toBe(failure);
  }).pipe(Effect.provide(layer));
});
