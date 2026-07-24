import { z } from "zod";

export const RigCronJobSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  command: z.string().min(1),
  schedule: z.string().min(1),
  input: z.unknown().optional(),
});

export const RigConfigSchema = z.object({
  version: z.literal(1),
  baseRegistryDir: z.string().min(1),
  customRegistries: z.array(z.string()),
  cronJobs: z.array(RigCronJobSchema).default([]),
});

export type RigConfig = z.infer<typeof RigConfigSchema>;
export type RigCronJob = z.infer<typeof RigCronJobSchema>;
