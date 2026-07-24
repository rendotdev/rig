import { describe, expect, it } from "vite-plus/test";
import {
  RigError,
  RigErrorClass,
  RigErrorsClass,
  RigErrorSingleton,
  rigErrors,
  type RigError as RigErrorInstance,
} from "./rig-error";

describe("RigErrorSingleton", () => {
  it("creates Rig errors through the production singleton", () => {
    const details = { field: "name" };
    const productionError = RigErrorSingleton.create({
      code: "INPUT_ERROR",
      message: "Invalid name.",
      details,
    });
    const builtError = RigErrorSingleton.create({
      code: "CONFIG_INVALID",
      message: "Invalid config.",
    });

    expect(productionError).toBeInstanceOf(Error);
    expect(productionError).toBeInstanceOf(RigErrorClass);
    expect(productionError).toMatchObject({
      name: "RigError",
      code: "INPUT_ERROR",
      message: "Invalid name.",
      details,
    });
    expect(builtError).toMatchObject({
      name: "RigError",
      code: "CONFIG_INVALID",
      message: "Invalid config.",
      details: undefined,
    });
  });

  it("preserves Rig error identity and normalizes other errors", () => {
    const existing = RigErrorSingleton.create({ code: "TOOL_INVALID", message: "Invalid tool." });

    expect(RigErrorSingleton.from({ error: existing })).toBe(existing);
    expect(RigErrorSingleton.from({ error: new Error("Plain failure.") })).toMatchObject({
      name: "RigError",
      code: "INTERNAL_ERROR",
      message: "Plain failure.",
      details: undefined,
    });
    expect(RigErrorSingleton.from({ error: "String failure." })).toMatchObject({
      name: "RigError",
      code: "INTERNAL_ERROR",
      message: "String failure.",
      details: undefined,
    });
  });
});

describe("Rig error compatibility adapters", () => {
  it("keeps RigErrorClass and RigError constructible without production classes", () => {
    const details = { command: "missing" };
    const classError = new RigErrorClass("COMMAND_NOT_FOUND", "Missing command.", details);
    const aliasError: RigErrorInstance = new RigError("INPUT_ERROR", "Invalid input.");

    expect(RigError).toBe(RigErrorClass);
    expect(RigErrorClass.name).toBe("RigErrorClass");
    expect(classError).toBeInstanceOf(Error);
    expect(classError).toBeInstanceOf(RigErrorClass);
    expect(aliasError).toBeInstanceOf(RigErrorClass);
    expect(classError).toMatchObject({
      name: "RigError",
      code: "COMMAND_NOT_FOUND",
      message: "Missing command.",
      details,
    });
    expect(aliasError.details).toBeUndefined();
    expect(RigErrorClass.prototype.constructor).toBe(RigErrorClass);
  });

  it("keeps RigErrorsClass construction, prototype behavior, and rigErrors normalization", () => {
    const errors = new RigErrorsClass();
    const existing = new RigErrorClass("CRON_ERROR", "Invalid schedule.");

    expect(errors).toBeInstanceOf(RigErrorsClass);
    expect(RigErrorsClass.name).toBe("RigErrorsClass");
    expect(Object.hasOwn(RigErrorsClass.prototype, "from")).toBe(true);
    expect(errors.from(existing)).toBe(existing);
    expect(RigErrorsClass.prototype.from(existing)).toBe(existing);
    expect(rigErrors.from(existing)).toBe(existing);
    expect(rigErrors.from(new Error("Plain failure."))).toMatchObject({
      name: "RigError",
      code: "INTERNAL_ERROR",
      message: "Plain failure.",
    });
    expect(rigErrors.from(42)).toMatchObject({
      name: "RigError",
      code: "INTERNAL_ERROR",
      message: "42",
    });
  });
});
