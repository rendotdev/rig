import { describe, expect, test } from "vite-plus/test";
import {
  EnvelopeFactoryClass,
  EnvelopeFactorySingleton,
  envelopeFactory,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from "./envelope";

describe("EnvelopeFactorySingleton", () => {
  test("success returns a data envelope with an empty errors array", () => {
    const result = EnvelopeFactorySingleton.success({ data: { ok: true } });
    expect(result).toEqual<SuccessEnvelope>({ data: { ok: true }, errors: [] });
  });

  test("success preserves null and undefined data", () => {
    expect(EnvelopeFactorySingleton.success({ data: null })).toEqual({
      data: null,
      errors: [],
    });
    expect(EnvelopeFactorySingleton.success({ data: undefined })).toEqual({
      data: undefined,
      errors: [],
    });
  });

  test("error returns a null-data envelope with a single issue", () => {
    const result = EnvelopeFactorySingleton.error({ code: "INPUT_ERROR", message: "bad input" });
    expect(result).toMatchObject<ErrorEnvelope>({
      data: null,
      errors: [{ code: "INPUT_ERROR", message: "bad input" }],
    });
  });

  test("error includes details when provided", () => {
    const result = EnvelopeFactorySingleton.error({
      code: "INTERNAL_ERROR",
      message: "unexpected",
      details: { field: "x" },
    });
    expect(result.errors[0].details).toEqual({ field: "x" });
  });
});

describe("EnvelopeFactoryClass adapter", () => {
  test("new EnvelopeFactoryClass() produces a usable instance", () => {
    const factory = new EnvelopeFactoryClass();
    expect(factory.success({ data: 42 })).toEqual({ data: 42, errors: [] });
    expect(factory.error({ code: "X", message: "y" })).toMatchObject({
      data: null,
      errors: [{ code: "X", message: "y" }],
    });
  });

  test("instanceof EnvelopeFactoryClass is true for instances", () => {
    const factory = new EnvelopeFactoryClass();
    expect(factory instanceof EnvelopeFactoryClass).toBe(true);
  });

  test("envelopeFactory is a shared pre-built instance", () => {
    expect(envelopeFactory.success({ data: "shared" })).toEqual({
      data: "shared",
      errors: [],
    });
    expect(envelopeFactory instanceof EnvelopeFactoryClass).toBe(true);
  });
});
