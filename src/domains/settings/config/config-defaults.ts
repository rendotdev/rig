import { defineSingleton } from "../../../define.ts";
import type { RigConfig } from "../types/config-schema.ts";

export const RigConfigDefaultsSingleton = defineSingleton({
  params: { baseRegistryDir: "~/rig/tools" },
  deps: {},
  create(params: Record<string, never>): RigConfig {
    void params;
    return {
      version: 1,
      baseRegistryDir: this.params.baseRegistryDir,
      customRegistries: [],
      cronJobs: [],
    };
  },
});

export type RigConfigDefaultsClass = {
  create(): RigConfig;
};

type RigConfigDefaultsConstructor = {
  new (): RigConfigDefaultsClass;
  readonly prototype: RigConfigDefaultsClass;
};

function RigConfigDefaultsConstructorAdapter(this: RigConfigDefaultsClass) {
  Object.defineProperty(this, "create", {
    configurable: true,
    value: function create() {
      return RigConfigDefaultsSingleton.create({});
    },
    writable: true,
  });
}

export const RigConfigDefaultsClass =
  RigConfigDefaultsConstructorAdapter as unknown as RigConfigDefaultsConstructor;

export const rigConfigDefaults = new RigConfigDefaultsClass();
