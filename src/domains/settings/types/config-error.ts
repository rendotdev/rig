import { Schema } from "effect";

const RigConfigOperation = Schema.Literals([
  "acknowledgeMigration",
  "ensure",
  "read",
  "write",
  "update",
]);

export type RigConfigOperation = typeof RigConfigOperation.Type;

export class RigConfigError extends Schema.TaggedErrorClass<RigConfigError>()("RigConfigError", {
  operation: RigConfigOperation,
  cause: Schema.Defect(),
}) {}
