import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { CollectionFileMetadata } from "../types/tool-collection";

export class CollectionDocumentPathService extends Context.Service<
  CollectionDocumentPathService,
  {
    readonly filePath: (collectionPath: string, id: string) => Effect.Effect<string, RigError>;
    readonly metadata: (path: string) => Effect.Effect<CollectionFileMetadata, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionDocumentPathService", {
  make: Effect.gen(function* () {
    const normalizeError = (cause: unknown) =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
            details: cause,
          });
    const filePath = Effect.fn("CollectionDocumentPathService.filePath")(function* (
      collectionPath: string,
      id: string,
    ) {
      const isInvalidEntryId =
        !id || id === "." || id === ".." || id.includes("/") || id.includes("\\");
      if (isInvalidEntryId) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: `Invalid collection entry id: ${id}`,
        });
      }
      const root = resolve(collectionPath);
      const path = resolve(root, `${id}.md`);
      if (dirname(path) !== root) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: `Entry escapes collection: ${id}`,
        });
      }
      return path;
    });
    const metadata = Effect.fn("CollectionDocumentPathService.metadata")(function* (path: string) {
      const status = yield* Effect.try({ try: () => statSync(path), catch: normalizeError });
      return { mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs, size: status.size };
    });
    return { filePath, metadata } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionDocumentPathService,
    CollectionDocumentPathService.make,
  );
}
