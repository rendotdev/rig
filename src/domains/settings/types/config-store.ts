import type { RigConfig } from "./config-schema";

export type RigConfigMutator = (config: RigConfig) => RigConfig | Promise<RigConfig>;
