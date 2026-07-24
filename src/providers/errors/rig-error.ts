import { defineSingleton } from "../../define.ts";
import type { ErrorCode } from "./codes";

export type RigErrorClass = Error & {
  code: ErrorCode;
  details: unknown;
};

type RigErrorConstructor = {
  new (code: ErrorCode, message: string, details?: unknown): RigErrorClass;
  readonly prototype: RigErrorClass;
};

type RigErrorsConstructor = {
  new (): RigErrorsClass;
  readonly prototype: RigErrorsClass;
};

const rigErrorPrototype = Object.create(Error.prototype) as RigErrorClass;

function createRigError(params: {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}): RigErrorClass {
  const error = new Error(params.message) as RigErrorClass;
  Object.setPrototypeOf(error, rigErrorPrototype);
  error.name = "RigError";
  error.code = params.code;
  error.details = params.details;
  return error;
}

export const RigErrorSingleton = defineSingleton({
  params: {},
  deps: {},
  create: createRigError,
  from(params: { readonly error: unknown }): RigErrorClass {
    if (
      typeof params.error === "object" &&
      params.error !== null &&
      rigErrorPrototype.isPrototypeOf(params.error)
    ) {
      return params.error as RigErrorClass;
    }
    if (params.error instanceof Error) {
      return createRigError({ code: "INTERNAL_ERROR", message: params.error.message });
    }
    return createRigError({ code: "INTERNAL_ERROR", message: String(params.error) });
  },
});

const RigErrorClassAdapter = function constructRigError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): RigErrorClass {
  return RigErrorSingleton.create({ code, message, details });
};
RigErrorClassAdapter.prototype = rigErrorPrototype;
Object.defineProperty(RigErrorClassAdapter, "name", { value: "RigErrorClass" });
Object.defineProperty(rigErrorPrototype, "constructor", {
  configurable: true,
  value: RigErrorClassAdapter,
  writable: true,
});

export const RigErrorClass = RigErrorClassAdapter as unknown as RigErrorConstructor;
export { RigErrorClass as RigError };

export type RigErrorsClass = {
  from(error: unknown): RigErrorClass;
};

const RigErrorsClassAdapter = function constructRigErrors() {};
Object.defineProperty(RigErrorsClassAdapter, "name", { value: "RigErrorsClass" });
Object.defineProperty(RigErrorsClassAdapter.prototype, "from", {
  configurable: true,
  value: function from(error: unknown): RigErrorClass {
    return RigErrorSingleton.from({ error });
  },
  writable: true,
});

export const RigErrorsClass = RigErrorsClassAdapter as unknown as RigErrorsConstructor;
export const rigErrors = new RigErrorsClass();
