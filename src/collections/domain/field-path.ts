import { RigErrorClass } from "../../errors/RigError";

export type CompiledCollectionFieldPath = {
  readonly segments: readonly string[];
  readonly sqliteJsonPath: string;
  read(value: unknown): unknown;
};

export class CollectionFieldPathCompilerClass {
  compile(value: string): CompiledCollectionFieldPath {
    if (typeof value !== "string" || value.length === 0) {
      throw this.invalid(value);
    }

    const segments = value.split(".");
    if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment))) {
      throw this.invalid(value);
    }

    return {
      segments,
      sqliteJsonPath: `$${segments.map((segment) => `.${segment}`).join("")}`,
      read: (input: unknown) => {
        let current = input;
        for (const segment of segments) {
          if (typeof current !== "object" || current === null || Array.isArray(current)) {
            return undefined;
          }
          current = (current as Record<string, unknown>)[segment];
        }
        return current;
      },
    };
  }

  private invalid(value: unknown): RigErrorClass {
    return new RigErrorClass("INPUT_ERROR", `Invalid collection field path: ${String(value)}`, {
      expected: "dot-separated field names beginning with a letter or underscore",
    });
  }
}

export const collectionFieldPathCompiler = new CollectionFieldPathCompilerClass();
