/* oxlint-disable vitest/no-standalone-expect -- @effect/vitest owns this Effect-aware test. */
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { rigConfigDefaults } from "../../domains/settings/config/config-defaults.ts";
import { RigConfigService, type RigConfigServiceImplementation } from "./config-effect-service";

it.effect("exposes every config operation through a replaceable layer", () => {
  let stored = rigConfigDefaults.create();
  const implementation: RigConfigServiceImplementation = {
    async acknowledgeMigrationPrompt() {},
    async ensure() {
      return stored;
    },
    async read() {
      return stored;
    },
    async write(params) {
      stored = params.config;
    },
    async update(params) {
      stored = await params.mutator(stored);
      return stored;
    },
  };

  return Effect.gen(function* () {
    const config = yield* RigConfigService;
    yield* config.acknowledgeMigrationPrompt;
    expect(yield* config.ensure).toEqual(stored);
    expect(yield* config.read).toEqual(stored);
    yield* config.write({ ...stored, customRegistries: ["written"] });
    expect((yield* config.update((current) => current)).customRegistries).toEqual(["written"]);
  }).pipe(Effect.provide(RigConfigService.makeLayer(implementation)));
});

it.effect("retains config failures in the typed error channel", () => {
  const failure = new Error("config unavailable");
  const implementation: RigConfigServiceImplementation = {
    async acknowledgeMigrationPrompt() {},
    async ensure() {
      throw failure;
    },
    async read() {
      throw failure;
    },
    async write() {},
    async update() {
      throw failure;
    },
  };

  return Effect.gen(function* () {
    const config = yield* RigConfigService;
    const error = yield* config.ensure.pipe(Effect.flip);
    expect(error.operation).toBe("ensure");
    expect(error.cause).toBe(failure);
  }).pipe(Effect.provide(RigConfigService.makeLayer(implementation)));
});
