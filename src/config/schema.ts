import { z } from "zod";

export const RigConfigSchema = z.object({
  version: z.literal(1),
  baseRegistryDir: z.string().min(1),
  customRegistries: z.array(z.string()),
});

export type RigConfig = z.infer<typeof RigConfigSchema>;

export class RigConfigDefaults {
  static create(): RigConfig {
    return {
      version: 1,
      baseRegistryDir: "~/.rig/tools",
      customRegistries: [],
    };
  }
}
