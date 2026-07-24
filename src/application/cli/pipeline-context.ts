import { readFileSync } from "node:fs";
import { defineService } from "../../define";
import { RigErrorClass } from "../../errors/RigError";

function isPipelineRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pipelineContext(envelope: unknown): Record<string, unknown> {
  if (!isPipelineRecord(envelope)) return {};
  return isPipelineRecord(envelope.pipe) ? { ...envelope.pipe } : {};
}

function validatePipelineId(id: string): void {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return;
  throw new RigErrorClass("INPUT_ERROR", `Pipeline id is invalid: ${id}`, { id });
}

const RunPipelineContextServiceDeps: {
  readStdin: () => string;
  parseJson: (text: string) => unknown;
} = {
  /* v8 ignore next 3 -- production stdin is exercised by CLI integration */
  readStdin: function readStdin() {
    return readFileSync(0, "utf8");
  },
  /* v8 ignore next 3 -- production parser is exercised through CLI integration */
  parseJson: function parseJson(text: string) {
    return JSON.parse(text) as unknown;
  },
};

export class RunPipelineContextService extends defineService({
  params: {},
  deps: RunPipelineContextServiceDeps,
}) {
  public query(params: { value: unknown; path: string }): unknown {
    let current = params.value;
    for (const part of params.path.split(".").filter(Boolean)) {
      if (!isPipelineRecord(current) && !Array.isArray(current)) {
        throw new RigErrorClass("INPUT_ERROR", `Query cannot access: ${params.path}`, {
          path: params.path,
          missing: part,
        });
      }
      current = (current as Record<string, unknown>)[part];
      if (current === undefined) {
        throw new RigErrorClass("INPUT_ERROR", `Query is missing: ${params.path}`, {
          path: params.path,
          missing: part,
        });
      }
    }
    return current;
  }

  public readFromStdin(_params: {}): Record<string, unknown> {
    const text = this.deps.readStdin().trim();
    if (!text) return {};
    const envelope = this.deps.parseJson(text);
    const context = pipelineContext(envelope);
    const data = this.query({ value: envelope, path: "data" });
    context.prev = data;
    return context;
  }

  public withOutputId(params: {
    envelope: unknown;
    context: Record<string, unknown>;
    id?: string;
  }): unknown {
    if (!params.id) return params.envelope;
    validatePipelineId(params.id);
    if (!isPipelineRecord(params.envelope)) return params.envelope;
    const data = params.envelope.data;
    return { ...params.envelope, pipe: { ...params.context, [params.id]: data } };
  }
}

export const RunPipelineContext = new RunPipelineContextService();

export type RunPipelineContextServiceClass = {
  readFromStdin(): Record<string, unknown>;
  withOutputId(envelope: unknown, context: Record<string, unknown>, id?: string): unknown;
  query(value: unknown, path: string): unknown;
};

type RunPipelineContextServiceConstructor = {
  new (): RunPipelineContextServiceClass;
  readonly prototype: RunPipelineContextServiceClass;
};

const RunPipelineContextServiceClassAdapter = function constructRunPipelineContext(): void {};
Object.defineProperty(RunPipelineContextServiceClassAdapter, "name", {
  value: "RunPipelineContextServiceClass",
});
Object.defineProperties(RunPipelineContextServiceClassAdapter.prototype, {
  readFromStdin: {
    configurable: true,
    /* v8 ignore next 3 -- compatibility path delegates to production stdin */
    value: function readFromStdin(): Record<string, unknown> {
      return RunPipelineContext.readFromStdin({});
    },
    writable: true,
  },
  withOutputId: {
    configurable: true,
    value: function withOutputId(
      envelope: unknown,
      context: Record<string, unknown>,
      id?: string,
    ): unknown {
      return RunPipelineContext.withOutputId({ envelope, context, id });
    },
    writable: true,
  },
  query: {
    configurable: true,
    value: function query(value: unknown, path: string): unknown {
      return RunPipelineContext.query({ value, path });
    },
    writable: true,
  },
});

export const RunPipelineContextServiceClass =
  RunPipelineContextServiceClassAdapter as unknown as RunPipelineContextServiceConstructor;
