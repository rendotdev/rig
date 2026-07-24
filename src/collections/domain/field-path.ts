import { defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";

export type CompiledCollectionFieldPath = {
  readonly segments: readonly string[];
  readonly sqliteJsonPath: string;
  read(value: unknown): unknown;
};

function invalidFieldPath(value: unknown): InstanceType<typeof RigErrorClass> {
  return new RigErrorClass("INPUT_ERROR", `Invalid collection field path: ${String(value)}`, {
    expected: "dot-separated field names beginning with a letter or underscore",
  });
}

export const CollectionFieldPathSingleton = defineSingleton({
  params: {},
  deps: {},
  compile(params: { value: string }): CompiledCollectionFieldPath {
    if (typeof params.value !== "string" || params.value.length === 0) {
      throw invalidFieldPath(params.value);
    }

    const segments = params.value.split(".");
    if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment))) {
      throw invalidFieldPath(params.value);
    }

    return {
      segments,
      sqliteJsonPath: `$${segments.map((segment) => `.${segment}`).join("")}`,
      read(input: unknown) {
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
  },
});

type CollectionFieldPathCompilerConstructor = {
  new (): CollectionFieldPathCompilerClass;
  readonly prototype: CollectionFieldPathCompilerClass;
};

export type CollectionFieldPathCompilerClass = {
  compile(value: string): CompiledCollectionFieldPath;
};

const CollectionFieldPathCompilerClassAdapter =
  function constructCollectionFieldPathCompiler(): void {};
Object.defineProperty(CollectionFieldPathCompilerClassAdapter, "name", {
  value: "CollectionFieldPathCompilerClass",
});
Object.defineProperty(CollectionFieldPathCompilerClassAdapter.prototype, "compile", {
  configurable: true,
  value: function compile(value: string): CompiledCollectionFieldPath {
    return CollectionFieldPathSingleton.compile({ value });
  },
  writable: true,
});

export const CollectionFieldPathCompilerClass =
  CollectionFieldPathCompilerClassAdapter as unknown as CollectionFieldPathCompilerConstructor;

export const collectionFieldPathCompiler = new CollectionFieldPathCompilerClass();
