import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RigConfigDefaultsService } from "./config-defaults";

describe("RigConfigDefaultsService", () => {
  it("creates independent default config values for each layer instance", async () => {
    const load = Effect.gen(function* () {
      return yield* (yield* RigConfigDefaultsService).get;
    }).pipe(Effect.provide(RigConfigDefaultsService.layer), Effect.runPromise);

    const first = await load;
    const second = await Effect.gen(function* () {
      return yield* (yield* RigConfigDefaultsService).get;
    }).pipe(Effect.provide(RigConfigDefaultsService.layer), Effect.runPromise);

    expect(first).toEqual({
      version: 1,
      baseRegistryDir: "~/rig/tools",
      customRegistries: [],
      cronJobs: [],
    });
    expect(first).not.toBe(second);
    expect(first.customRegistries).not.toBe(second.customRegistries);
    expect(first.cronJobs).not.toBe(second.cronJobs);
  });
});
