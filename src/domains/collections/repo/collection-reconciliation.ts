import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { CollectionOperationContext } from "../types/collection-operation-context";
import type { CollectionFileMetadata, CollectionIndexInterface } from "../types/tool-collection";
import { CollectionDocumentPathService } from "./collection-document-path";
import { CollectionEntryCodecService } from "./collection-entry-codec";
import { FrontmatterCodecService } from "./frontmatter-codec";

export class CollectionReconciliationService extends Context.Service<
  CollectionReconciliationService,
  {
    readonly reconcile: (context: CollectionOperationContext) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionReconciliationService", {
  make: Effect.gen(function* () {
    const entries = yield* CollectionEntryCodecService;
    const paths = yield* CollectionDocumentPathService;
    const frontmatter = yield* FrontmatterCodecService;
    const normalizeError = (cause: unknown) =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
            details: cause,
          });
    const matches = (
      tracked: ReturnType<CollectionIndexInterface["getFile"]>,
      actual: CollectionFileMetadata,
    ) =>
      tracked !== null &&
      tracked.mtimeMs === actual.mtimeMs &&
      tracked.ctimeMs === actual.ctimeMs &&
      tracked.size === actual.size;
    const reconcileFile = Effect.fn("CollectionReconciliationService.reconcileFile")(function* (
      context: CollectionOperationContext,
      file: string,
      fileIds: Set<string>,
    ) {
      const id = file.slice(0, -3);
      fileIds.add(id);
      const path = join(context.path, file);
      const metadata = yield* paths.metadata(path);
      if (matches(context.index.getFile(id), metadata)) return;
      yield* Effect.gen(function* () {
        const source = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: normalizeError,
        });
        const parsed = yield* frontmatter.parse(source);
        const stable = yield* paths.metadata(path);
        const indexed = context.index.getDoc(id);
        context.index.upsertDoc(
          {
            id,
            data: yield* entries.validate(context.definition, parsed.data),
            body: parsed.body,
            createdAt: indexed?.created_at ?? new Date(stable.ctimeMs).toISOString(),
            updatedAt: new Date(stable.mtimeMs).toISOString(),
          },
          stable.mtimeMs,
        );
        context.index.upsertFile({ id, status: "indexed", ...stable });
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            context.index.deleteDoc(id);
            context.index.upsertFile({ id, status: "invalid", ...metadata });
          }),
        ),
      );
    });
    const reconcile = Effect.fn("CollectionReconciliationService.reconcile")(function* (
      context: CollectionOperationContext,
    ) {
      const files = yield* Effect.try({
        try: () => readdirSync(context.path).filter((file) => file.endsWith(".md")),
        catch: normalizeError,
      });
      const knownIds = new Set([...context.index.allIds(), ...context.index.allFileIds()]);
      const fileIds = new Set<string>();
      yield* Effect.forEach(files, (file) => reconcileFile(context, file, fileIds), {
        concurrency: "unbounded",
      });
      for (const id of knownIds) {
        if (fileIds.has(id)) continue;
        context.index.deleteDoc(id);
        context.index.deleteFile(id);
      }
    });
    return { reconcile } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionReconciliationService,
    CollectionReconciliationService.make,
  );
}
