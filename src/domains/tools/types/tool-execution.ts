import { Schema } from "effect";

export const ToolExecutionOperation = Schema.Literals([
  "database",
  "kv",
  "cache",
  "collections",
  "command",
  "output",
]);

export type ToolExecutionOperation = typeof ToolExecutionOperation.Type;

export class ToolExecutionError extends Schema.TaggedErrorClass<ToolExecutionError>()(
  "ToolExecutionError",
  {
    operation: ToolExecutionOperation,
    cause: Schema.Defect(),
  },
) {}
