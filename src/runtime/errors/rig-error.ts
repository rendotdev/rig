import type { ErrorCode } from "./codes";

export class RigErrorClass extends Error {
  code: ErrorCode;
  details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RigError";
    this.code = code;
    this.details = details;
  }
}

export class RigErrorsClass {
  from(error: unknown): RigErrorClass {
    if (error instanceof RigErrorClass) return error;
    if (error instanceof Error) return new RigErrorClass("INTERNAL_ERROR", error.message);
    return new RigErrorClass("INTERNAL_ERROR", String(error));
  }
}

export const rigErrors = new RigErrorsClass();

export { RigErrorClass as RigError };
