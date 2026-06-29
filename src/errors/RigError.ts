import type { ErrorCode } from "./codes";

export class RigError extends Error {
  code: ErrorCode;
  details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RigError";
    this.code = code;
    this.details = details;
  }
}

export class RigErrors {
  static from(error: unknown): RigError {
    if (error instanceof RigError) return error;
    if (error instanceof Error) return new RigError("INPUT_ERROR", error.message);
    return new RigError("INPUT_ERROR", String(error));
  }
}
