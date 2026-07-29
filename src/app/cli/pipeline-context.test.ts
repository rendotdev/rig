import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { PipelineInputPlatformService, PipelineInputService } from "./pipeline-context";

const inputLayer = (text: string, parseJson: (text: string) => unknown = JSON.parse) =>
  PipelineInputService.layer.pipe(
    Layer.provide(
      Layer.succeed(PipelineInputPlatformService, {
        readStdin: Effect.succeed(text),
        parseJson: Effect.fn("PipelineInputPlatformService.parseJson")(function* (value) {
          return parseJson(value);
        }),
      }),
    ),
  );

const runInput = <A, E>(
  text: string,
  use: (service: PipelineInputService["Service"]) => Effect.Effect<A, E>,
) => Effect.runPromise(PipelineInputService.use(use).pipe(Effect.provide(inputLayer(text))));

describe("pipeline context", () => {
  it("reads pipeline context and previous data from stdin", async () => {
    await expect(
      runInput(
        JSON.stringify({ pipe: { first: 1 }, data: { value: 2 } }),
        (service) => service.read,
      ),
    ).resolves.toEqual({ first: 1, prev: { value: 2 } });
  });

  it("handles envelopes without inherited pipeline context", async () => {
    await expect(
      runInput(JSON.stringify({ data: null }), (service) => service.read),
    ).resolves.toEqual({
      prev: null,
    });
    await expect(
      runInput(JSON.stringify({ pipe: "invalid", data: 2 }), (service) => service.read),
    ).resolves.toEqual({ prev: 2 });
    await expect(runInput("null", (service) => service.read)).rejects.toThrow(
      "Query cannot access: data",
    );
  });

  it("returns an empty context for empty stdin", async () => {
    const layer = PipelineInputService.layer.pipe(
      Layer.provide(
        Layer.succeed(PipelineInputPlatformService, {
          readStdin: Effect.succeed("  "),
          parseJson: () => Effect.die("must not parse"),
        }),
      ),
    );
    await expect(
      Effect.runPromise(
        PipelineInputService.use((service) => service.read).pipe(Effect.provide(layer)),
      ),
    ).resolves.toEqual({});
  });

  it("queries object and array paths and reports inaccessible values", async () => {
    await expect(
      runInput("", (service) => service.query({ items: [{ name: "rig" }] }, "items.0.name")),
    ).resolves.toBe("rig");
    await expect(runInput("", (service) => service.query("unchanged", ""))).resolves.toBe(
      "unchanged",
    );
    await expect(
      runInput("", (service) => service.query({ item: null }, "item.name")),
    ).rejects.toThrow("Query cannot access: item.name");
    await expect(
      runInput("", (service) => service.query({ item: {} }, "item.name")),
    ).rejects.toThrow("Query is missing: item.name");
  });

  it("adds output IDs while preserving existing context", async () => {
    const envelope = { data: { ok: true }, errors: [] };
    await expect(
      runInput("", (service) => service.attach(envelope, { previous: 1 }, "step_2")),
    ).resolves.toEqual({ ...envelope, pipe: { previous: 1, step_2: { ok: true } } });
    await expect(runInput("", (service) => service.attach(envelope, {}))).resolves.toBe(envelope);
    await expect(runInput("", (service) => service.attach("value", {}, "step"))).resolves.toBe(
      "value",
    );
    await expect(runInput("", (service) => service.attach(envelope, {}, "bad.id"))).rejects.toThrow(
      "Pipeline id is invalid: bad.id",
    );
  });
});
