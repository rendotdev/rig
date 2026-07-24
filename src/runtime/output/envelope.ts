import { defineSingleton } from "../../define";
import type { ErrorCode } from "../../errors/codes";

export type RigIssue = {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
};

export type SuccessEnvelope = {
  data: unknown;
  errors: [];
};

export type ErrorEnvelope = {
  data: null;
  errors: [RigIssue];
};

function buildSuccessEnvelope(params: { data: unknown }): SuccessEnvelope {
  return { data: params.data, errors: [] };
}

function buildErrorEnvelope(params: {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
}): ErrorEnvelope {
  return {
    data: null,
    errors: [{ code: params.code, message: params.message, details: params.details }],
  };
}

export const EnvelopeFactorySingleton = defineSingleton({
  params: {},
  deps: {},
  success: buildSuccessEnvelope,
  error: buildErrorEnvelope,
});

// --- Class-free adapter (backward compatibility) ---

type EnvelopeFactoryCompatibility = {
  success(params: { data: unknown }): SuccessEnvelope;
  error(params: { code: ErrorCode | string; message: string; details?: unknown }): ErrorEnvelope;
};

type EnvelopeFactoryConstructor = {
  new (): EnvelopeFactoryCompatibility;
  readonly prototype: EnvelopeFactoryCompatibility;
};

const EnvelopeFactoryClassAdapter = function constructEnvelopeFactory() {};
Object.defineProperty(EnvelopeFactoryClassAdapter, "name", { value: "EnvelopeFactoryClass" });
Object.defineProperty(EnvelopeFactoryClassAdapter.prototype, "success", {
  configurable: true,
  value: function success(params: { data: unknown }): SuccessEnvelope {
    return EnvelopeFactorySingleton.success(params);
  },
  writable: true,
});
Object.defineProperty(EnvelopeFactoryClassAdapter.prototype, "error", {
  configurable: true,
  value: function error(params: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  }): ErrorEnvelope {
    return EnvelopeFactorySingleton.error(params);
  },
  writable: true,
});

export const EnvelopeFactoryClass =
  EnvelopeFactoryClassAdapter as unknown as EnvelopeFactoryConstructor;

export const envelopeFactory = new EnvelopeFactoryClass();
