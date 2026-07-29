import { Schema } from "effect";

export type UpdateCheckNotice = Readonly<{
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  message: string;
}>;

export type NpmUpdateCheckConfig = Readonly<{
  updateCheckCachePath: string;
  cacheTtlMs: number;
  timeoutMs: number;
  packageName: string;
}>;

export const UpdateCheckCache = Schema.Struct({
  checkedAt: Schema.Finite,
  latestVersion: Schema.optional(Schema.String),
});
export type UpdateCheckCache = typeof UpdateCheckCache.Type;

export const NpmRegistryResponse = Schema.Struct({ version: Schema.String });

export class NpmRegistryError extends Schema.TaggedErrorClass<NpmRegistryError>()(
  "NpmRegistryError",
  { cause: Schema.Defect() },
) {}

export class NpmRegistryResponseError extends Schema.TaggedErrorClass<NpmRegistryResponseError>()(
  "NpmRegistryResponseError",
  { status: Schema.Finite },
) {}

export class NpmUpdateCheckError extends Schema.TaggedErrorClass<NpmUpdateCheckError>()(
  "NpmUpdateCheckError",
  { cause: Schema.Defect() },
) {}

export type RigUpdateStep = { command: string; args: string[]; env?: NodeJS.ProcessEnv };

export type RigUpdatePlan =
  | {
      status: "ready";
      currentVersion: string;
      latestVersion: string;
      updateStep: RigUpdateStep;
      versionStep: RigUpdateStep;
      syncStep: RigUpdateStep;
    }
  | { status: "current"; version: string; syncStep: RigUpdateStep }
  | { status: "skipped"; reason: string };

export type RigUpdateResult =
  | {
      status: "updated";
      previousVersion: string;
      version: string;
      step: RigUpdateStep;
      output: string;
    }
  | { status: "current"; version: string }
  | { status: "skipped"; reason: string };

export type RunnableRigUpdatePlan = Exclude<RigUpdatePlan, { status: "skipped" }>;

export type RigUpdaterParams = Readonly<{ packageRoot: string; currentVersion: string }>;

export type RigInstallation =
  | { kind: "npm" | "bun"; packageManager: string; prefix: string; rig: string }
  | { reason: string };

export const RigPackageManifest = Schema.Struct({ version: Schema.String });

const RigUpdateOperation = Schema.Literals(["command", "plan", "update", "sync"]);

export class RigUpdateError extends Schema.TaggedErrorClass<RigUpdateError>()("RigUpdateError", {
  operation: RigUpdateOperation,
  cause: Schema.Defect(),
}) {}
