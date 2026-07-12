import { readFileSync } from "node:fs";
import { RigErrorClass } from "../../errors/RigError";

export class RunPipelineContextServiceClass {
  /* v8 ignore next 8 */
  readFromStdin(): Record<string, unknown> {
    const text = readFileSync(0, "utf8").trim();
    if (!text) return {};
    const envelope = JSON.parse(text) as unknown;
    const context = this.pipelineContext(envelope);
    const data = this.query(envelope, "data");
    if (data !== undefined) context.prev = data;
    return context;
  }

  withOutputId(envelope: unknown, context: Record<string, unknown>, id?: string): unknown {
    if (!id) return envelope;
    this.validateId(id);
    /* v8 ignore next */
    if (!this.isRecord(envelope)) return envelope;
    const data = envelope.data;
    return { ...envelope, pipe: { ...context, [id]: data } };
  }

  query(value: unknown, path: string): unknown {
    let current = value;
    for (const part of path.split(".").filter(Boolean)) {
      if (!this.isRecord(current) && !Array.isArray(current)) {
        throw new RigErrorClass("INPUT_ERROR", `Query cannot access: ${path}`, {
          path,
          missing: part,
        });
      }
      current = (current as Record<string, unknown>)[part];
      if (current === undefined) {
        throw new RigErrorClass("INPUT_ERROR", `Query is missing: ${path}`, {
          path,
          missing: part,
        });
      }
    }
    return current;
  }

  /* v8 ignore next 4 */
  private pipelineContext(envelope: unknown): Record<string, unknown> {
    if (!this.isRecord(envelope)) return {};
    return this.isRecord(envelope.pipe) ? { ...envelope.pipe } : {};
  }

  private validateId(id: string): void {
    if (/^[A-Za-z0-9_-]+$/.test(id)) return;
    throw new RigErrorClass("INPUT_ERROR", `Pipeline id is invalid: ${id}`, { id });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
