import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RigError, RigErrorNormalizationService, rigErrorNormalizationLayer } from "./rig-error";

class WrappedError extends Schema.TaggedErrorClass<WrappedError>()("WrappedError", {
  cause: Schema.Defect(),
}) {}

const normalize = (cause: unknown) =>
  RigErrorNormalizationService.use((service) => service.normalize(cause)).pipe(
    Effect.provide(rigErrorNormalizationLayer),
    Effect.runPromise,
  );

describe("RigError", () => {
  it("is a schema-backed tagged error", () => {
    const details = { command: "missing" };
    const error = new RigError({
      code: "COMMAND_NOT_FOUND",
      message: "Missing command.",
      details: details,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RigError);
    expect(error).toMatchObject({
      _tag: "RigError",
      name: "RigError",
      code: "COMMAND_NOT_FOUND",
      message: "Missing command.",
      details,
    });
  });

  it("preserves a RigError nested inside typed Effect errors", async () => {
    const expected = new RigError({
      code: "CONFIG_INVALID",
      message: "Config is not valid JSON.",
      details: { path: "rig.json" },
    });

    await expect(normalize(new WrappedError({ cause: expected }))).resolves.toBe(expected);
  });

  it("extracts a useful message from nested platform errors", async () => {
    const error = await normalize(new WrappedError({ cause: new Error("write failed") }));

    expect(error).toMatchObject({ code: "INTERNAL_ERROR", message: "write failed" });
  });

  it("uses a stable fallback for cyclic unknown errors", async () => {
    const error: { cause?: unknown } = {};
    error.cause = error;

    await expect(normalize(error)).resolves.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unknown Rig failure.",
    });
  });
});
