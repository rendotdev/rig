import { describe, expect, it } from "vite-plus/test";
import {
  RunPipelineContextService,
  RunPipelineContext,
  RunPipelineContextServiceClass,
} from "./pipeline-context";

describe("pipeline context", () => {
  it("reads pipeline context and previous data from stdin", () => {
    const Pipeline = new RunPipelineContextService({
      params: {},
      deps: {
        readStdin() {
          return JSON.stringify({ pipe: { first: 1 }, data: { value: 2 } });
        },
        parseJson(text) {
          return JSON.parse(text) as unknown;
        },
      },
    });

    expect(Pipeline.readFromStdin({})).toEqual({ first: 1, prev: { value: 2 } });
  });

  it("handles envelopes without inherited pipeline context", () => {
    const Pipeline = new RunPipelineContextService({
      params: {},
      deps: {
        readStdin() {
          return JSON.stringify({ data: null });
        },
        parseJson(text) {
          return JSON.parse(text) as unknown;
        },
      },
    });
    const NonRecordPipeline = new RunPipelineContextService({
      params: {},
      deps: {
        readStdin() {
          return JSON.stringify({ pipe: "invalid", data: 2 });
        },
        parseJson(text) {
          return JSON.parse(text) as unknown;
        },
      },
    });
    const NonEnvelopePipeline = new RunPipelineContextService({
      params: {},
      deps: {
        readStdin() {
          return "null";
        },
        parseJson(text) {
          return JSON.parse(text) as unknown;
        },
      },
    });

    expect(Pipeline.readFromStdin({})).toEqual({ prev: null });
    expect(NonRecordPipeline.readFromStdin({})).toEqual({ prev: 2 });
    expect(() => NonEnvelopePipeline.readFromStdin({})).toThrow("Query cannot access: data");
  });

  it("returns an empty context for empty stdin", () => {
    const Pipeline = new RunPipelineContextService({
      params: {},
      deps: {
        readStdin() {
          return "  ";
        },
        parseJson() {
          throw new Error("must not parse");
        },
      },
    });

    expect(Pipeline.readFromStdin({})).toEqual({});
  });

  it("queries object and array paths and reports inaccessible values", () => {
    expect(
      RunPipelineContext.query({
        value: { items: [{ name: "rig" }] },
        path: "items.0.name",
      }),
    ).toBe("rig");
    expect(RunPipelineContext.query({ value: "unchanged", path: "" })).toBe("unchanged");
    expect(() => RunPipelineContext.query({ value: { item: null }, path: "item.name" })).toThrow(
      "Query cannot access: item.name",
    );
    expect(() => RunPipelineContext.query({ value: { item: {} }, path: "item.name" })).toThrow(
      "Query is missing: item.name",
    );
  });

  it("adds output IDs while preserving existing context", () => {
    const envelope = { data: { ok: true }, errors: [] };

    expect(
      RunPipelineContext.withOutputId({
        envelope,
        context: { previous: 1 },
        id: "step_2",
      }),
    ).toEqual({
      ...envelope,
      pipe: { previous: 1, step_2: { ok: true } },
    });
    expect(RunPipelineContext.withOutputId({ envelope, context: {} })).toBe(envelope);
    expect(RunPipelineContext.withOutputId({ envelope: "value", context: {}, id: "step" })).toBe(
      "value",
    );
    expect(() => RunPipelineContext.withOutputId({ envelope, context: {}, id: "bad.id" })).toThrow(
      "Pipeline id is invalid: bad.id",
    );
  });

  it("preserves positional compatibility methods", () => {
    const adapter = new RunPipelineContextServiceClass();
    const envelope = { data: 2 };

    expect(adapter).toBeInstanceOf(RunPipelineContextServiceClass);
    expect(adapter.query({ value: 3 }, "value")).toBe(3);
    expect(adapter.withOutputId(envelope, {}, "result")).toEqual({
      data: 2,
      pipe: { result: 2 },
    });
  });
});
