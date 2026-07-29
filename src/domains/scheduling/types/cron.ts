import { Schema } from "effect";
import type { RigCronJob } from "../../settings/types/config-schema";

export type CronAddOptions = Readonly<{
  name: string;
  command: string;
  schedule: string;
  input?: string;
  inputFile?: string;
  moduleUrl: string;
}>;

export type CronRunResult = Readonly<{
  job: RigCronJob;
  envelope: unknown;
  exitCode: number;
}>;

export type CronWorkerSnapshot = Readonly<{ workerSource?: string }>;

const RigCronOperation = Schema.Literals(["list", "add", "remove", "run"]);

export class RigCronError extends Schema.TaggedErrorClass<RigCronError>()("RigCronError", {
  operation: RigCronOperation,
  cause: Schema.Defect(),
}) {}

export class CronStateError extends Schema.TaggedErrorClass<CronStateError>()("CronStateError", {
  cause: Schema.Defect(),
  rollbackErrors: Schema.optional(Schema.Array(Schema.Defect())),
}) {}
