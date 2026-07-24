import { describe, expect, test } from "vite-plus/test";
import {
  RigConfigDefaultsClass,
  RigConfigDefaultsSingleton,
  rigConfigDefaults,
} from "./config-defaults.ts";

describe("Rig config defaults", () => {
  test("builds fresh config arrays for every create operation", () => {
    const Defaults = RigConfigDefaultsSingleton;
    const first = Defaults.create({});
    const second = Defaults.create({});

    expect(first).toEqual({
      version: 1,
      baseRegistryDir: "~/rig/tools",
      customRegistries: [],
      cronJobs: [],
    });
    expect(first.customRegistries).not.toBe(second.customRegistries);
    expect(first.cronJobs).not.toBe(second.cronJobs);

    first.customRegistries.push("~/custom");
    first.cronJobs.push({ name: "daily", command: "tool.run", schedule: "@daily" });
    expect(second.customRegistries).toEqual([]);
    expect(second.cronJobs).toEqual([]);
    expect(RigConfigDefaultsSingleton.create({}).cronJobs).toEqual([]);
  });

  test("preserves the legacy constructor and shared defaults adapter", () => {
    const defaults = new RigConfigDefaultsClass();

    expect(defaults).toBeInstanceOf(RigConfigDefaultsClass);
    expect(rigConfigDefaults).toBeInstanceOf(RigConfigDefaultsClass);
    expect(defaults.create()).toEqual(RigConfigDefaultsSingleton.create({}));
    expect(defaults.create().customRegistries).not.toBe(defaults.create().customRegistries);
    expect(rigConfigDefaults.create().cronJobs).not.toBe(rigConfigDefaults.create().cronJobs);
  });
});
