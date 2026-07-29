import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type {
  CollectionData,
  CollectionOperationContext,
} from "../types/collection-operation-context";
import type { CollectionEntry } from "../types/tool-collection";
import { CollectionDocumentPathService } from "./collection-document-path";
import { CollectionEntryCodecService } from "./collection-entry-codec";
import { FrontmatterCodecService } from "./frontmatter-codec";

export class CollectionDocumentIoService extends Context.Service<
  CollectionDocumentIoService,
  {
    readonly write: (
      context: CollectionOperationContext,
      document: CollectionEntry<CollectionData>,
    ) => Effect.Effect<void, RigError>;
    readonly getEntry: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<CollectionEntry<CollectionData> | null, RigError>;
    readonly remove: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<boolean, RigError>;
    readonly clear: (context: CollectionOperationContext) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionDocumentIoService", {
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
    const write = Effect.fn("CollectionDocumentIoService.write")(function* (
      context: CollectionOperationContext,
      document: CollectionEntry<CollectionData>,
    ) {
      const path = yield* paths.filePath(context.path, document.id);
      const source = yield* frontmatter.serialize(document.data, document.body);
      yield* Effect.tryPromise({
        try: () => writeFile(path, source, "utf8"),
        catch: normalizeError,
      });
      const metadata = yield* paths.metadata(path);
      context.index.upsertDoc(document, metadata.mtimeMs);
      context.index.upsertFile({ id: document.id, status: "indexed", ...metadata });
    });
    const getEntry = Effect.fn("CollectionDocumentIoService.getEntry")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      const path = yield* paths.filePath(context.path, id);
      if (!existsSync(path)) return null;
      const source = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: normalizeError,
      });
      const parsed = yield* frontmatter.parse(source);
      const metadata = yield* paths.metadata(path);
      const row = context.index.getDoc(id);
      return {
        id,
        data: yield* entries.validate(context.definition, parsed.data),
        body: parsed.body,
        createdAt: row?.created_at ?? new Date(metadata.ctimeMs).toISOString(),
        updatedAt: row?.updated_at ?? new Date(metadata.mtimeMs).toISOString(),
      };
    });
    const remove = Effect.fn("CollectionDocumentIoService.remove")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      const path = yield* paths.filePath(context.path, id);
      if (!existsSync(path)) return false;
      yield* Effect.tryPromise({ try: () => unlink(path), catch: normalizeError });
      context.index.deleteDoc(id);
      context.index.deleteFile(id);
      return true;
    });
    const clear = Effect.fn("CollectionDocumentIoService.clear")(function* (
      context: CollectionOperationContext,
    ) {
      const ids = [...new Set([...context.index.allIds(), ...context.index.allFileIds()])];
      yield* Effect.forEach(ids, (id) =>
        paths
          .filePath(context.path, id)
          .pipe(
            Effect.flatMap((path) =>
              existsSync(path)
                ? Effect.tryPromise({ try: () => unlink(path), catch: normalizeError })
                : Effect.void,
            ),
          ),
      );
      context.index.clearAll();
    });
    return { write, getEntry, remove, clear } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionDocumentIoService,
    CollectionDocumentIoService.make,
  );
}

export class CollectionDocumentRepositoryService extends Context.Service<
  CollectionDocumentRepositoryService,
  {
    readonly create: (
      context: CollectionOperationContext,
      input: { id?: string; data: CollectionData; body?: string },
    ) => Effect.Effect<CollectionEntry<CollectionData>, RigError>;
    readonly getEntry: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<CollectionEntry<CollectionData> | null, RigError>;
    readonly update: (
      context: CollectionOperationContext,
      id: string,
      patch: { data?: CollectionData; body?: string },
    ) => Effect.Effect<CollectionEntry<CollectionData>, RigError>;
    readonly upsert: (
      context: CollectionOperationContext,
      input: { id: string; data: CollectionData; body?: string },
    ) => Effect.Effect<{ id: string; created: boolean }, RigError>;
    readonly remove: (
      context: CollectionOperationContext,
      id: string,
    ) => Effect.Effect<boolean, RigError>;
    readonly clear: (context: CollectionOperationContext) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/collections/CollectionDocumentRepositoryService", {
  make: Effect.gen(function* () {
    const documents = yield* CollectionDocumentIoService;
    const entries = yield* CollectionEntryCodecService;
    const paths = yield* CollectionDocumentPathService;
    const create = Effect.fn("CollectionDocumentRepositoryService.create")(function* (
      context: CollectionOperationContext,
      input: { id?: string; data: CollectionData; body?: string },
    ) {
      const data = yield* entries.validate(context.definition, input.data);
      const id = input.id ?? (yield* entries.deriveId(context.definition, data));
      if (id === undefined) {
        return yield* new RigError({
          code: "INPUT_ERROR",
          message: "Collection entry needs an id.",
        });
      }
      if (existsSync(yield* paths.filePath(context.path, id))) {
        return yield* new RigError({ code: "INPUT_ERROR", message: `Entry already exists: ${id}` });
      }
      const now = new Date().toISOString();
      const document = { id, data, body: input.body ?? "", createdAt: now, updatedAt: now };
      yield* documents.write(context, document);
      return document;
    });
    const getEntry = Effect.fn("CollectionDocumentRepositoryService.getEntry")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      return yield* documents.getEntry(context, id);
    });
    const update = Effect.fn("CollectionDocumentRepositoryService.update")(function* (
      context: CollectionOperationContext,
      id: string,
      patch: { data?: CollectionData; body?: string },
    ) {
      const existing = yield* documents.getEntry(context, id);
      if (!existing) {
        return yield* new RigError({ code: "INPUT_ERROR", message: `Entry not found: ${id}` });
      }
      const document = {
        id,
        data: patch.data
          ? yield* entries.validate(context.definition, { ...existing.data, ...patch.data })
          : existing.data,
        body: patch.body ?? existing.body,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      yield* documents.write(context, document);
      return document;
    });
    const upsert = Effect.fn("CollectionDocumentRepositoryService.upsert")(function* (
      context: CollectionOperationContext,
      input: { id: string; data: CollectionData; body?: string },
    ) {
      const exists = existsSync(yield* paths.filePath(context.path, input.id));
      if (exists) yield* update(context, input.id, { data: input.data, body: input.body });
      else yield* create(context, input);
      return { id: input.id, created: !exists };
    });
    const remove = Effect.fn("CollectionDocumentRepositoryService.remove")(function* (
      context: CollectionOperationContext,
      id: string,
    ) {
      return yield* documents.remove(context, id);
    });
    const clear = Effect.fn("CollectionDocumentRepositoryService.clear")(function* (
      context: CollectionOperationContext,
    ) {
      yield* documents.clear(context);
    });
    return { create, getEntry, update, upsert, remove, clear } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionDocumentRepositoryService,
    CollectionDocumentRepositoryService.make,
  );
}
