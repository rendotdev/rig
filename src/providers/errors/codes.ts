import { Schema } from "effect";

export const ErrorCode = Schema.Literals([
  "CONFIG_INVALID",
  "DUPLICATE_TOOL",
  "TOOL_NOT_FOUND",
  "COMMAND_NOT_FOUND",
  "TOOL_INVALID",
  "VALIDATION_ERROR",
  "OUTPUT_VALIDATION_ERROR",
  "INPUT_ERROR",
  "INTERNAL_ERROR",
  "SHELL_ERROR",
  "TOOL_RUN_ERROR",
  "TYPECHECK_ERROR",
  "CRON_ERROR",
  "DEV_LINK_ERROR",
]);
export type ErrorCode = typeof ErrorCode.Type;
