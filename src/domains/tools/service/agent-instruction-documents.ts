import { readFile, realpath, stat } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { AtomicFileWriterService } from "../../../providers/filesystem/atomic-file-writer";
import { RigError } from "../../../providers/errors/rig-error";
import {
  AgentInstructionEndMarker,
  AgentInstructionIgnoreMarker,
  AgentInstructionStartMarker,
  type AgentInstructionTarget,
} from "../types/agent-instruction";

class AgentInstructionDocumentStorageService extends Context.Service<
  AgentInstructionDocumentStorageService,
  {
    readonly isDirectory: (path: string) => Effect.Effect<boolean>;
    readonly isFile: (path: string) => Effect.Effect<boolean>;
    readonly isIgnored: (path: string) => Effect.Effect<boolean>;
    readonly readText: (path: string) => Effect.Effect<string, RigError>;
    readonly safeRealPath: (path: string) => Effect.Effect<string>;
    readonly writeText: (path: string, content: string) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionDocumentStorageService", {
  make: Effect.gen(function* () {
    const writer = yield* AtomicFileWriterService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const readText = Effect.fn("AgentInstructionDocumentStorageService.readText")(function* (
      path: string,
    ) {
      return yield* Effect.tryPromise({
        try: () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? Bun.file(path).text()
            : readFile(path, "utf8"),
        catch: toError,
      });
    });
    const writeText = Effect.fn("AgentInstructionDocumentStorageService.writeText")(function* (
      path: string,
      content: string,
    ) {
      yield* writer.write(path, content).pipe(Effect.mapError((error) => toError(error.cause)));
    });
    const isFile = Effect.fn("AgentInstructionDocumentStorageService.isFile")(function* (
      path: string,
    ) {
      return yield* Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.map((status) => status.isFile()),
        Effect.orElseSucceed(() => false),
      );
    });
    const isDirectory = Effect.fn("AgentInstructionDocumentStorageService.isDirectory")(function* (
      path: string,
    ) {
      return yield* Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.map((status) => status.isDirectory()),
        Effect.orElseSucceed(() => false),
      );
    });
    const isIgnored = Effect.fn("AgentInstructionDocumentStorageService.isIgnored")(function* (
      path: string,
    ) {
      return yield* readText(path).pipe(
        Effect.map((source) => source.includes(AgentInstructionIgnoreMarker)),
        Effect.orElseSucceed(() => false),
      );
    });
    const safeRealPath = Effect.fn("AgentInstructionDocumentStorageService.safeRealPath")(
      function* (path: string) {
        return yield* Effect.tryPromise({ try: () => realpath(path), catch: () => undefined }).pipe(
          Effect.orElseSucceed(() => path),
        );
      },
    );
    return { isDirectory, isFile, isIgnored, readText, safeRealPath, writeText } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionDocumentStorageService,
    AgentInstructionDocumentStorageService.make,
  );
}

class AgentInstructionManagedBlockService extends Context.Service<
  AgentInstructionManagedBlockService,
  {
    readonly remove: (target: AgentInstructionTarget) => Effect.Effect<boolean, RigError>;
    readonly upsert: (
      target: AgentInstructionTarget,
      block: string,
    ) => Effect.Effect<boolean, RigError>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionManagedBlockService", {
  make: Effect.gen(function* () {
    const documents = yield* AgentInstructionDocumentStorageService;
    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const managedBlockPattern = (): RegExp =>
      new RegExp(
        `${escapeRegExp(AgentInstructionStartMarker)}[\\s\\S]*?${escapeRegExp(AgentInstructionEndMarker)}`,
      );
    const upsert = Effect.fn("AgentInstructionManagedBlockService.upsert")(function* (
      target: AgentInstructionTarget,
      block: string,
    ) {
      const existing = target.existed ? yield* documents.readText(target.path) : "";
      const pattern = managedBlockPattern();
      const nextBody = pattern.test(existing)
        ? existing.replace(managedBlockPattern(), block)
        : [existing.trimEnd(), block].filter(Boolean).join("\n\n");
      const next = `${nextBody.trimEnd()}\n`;
      if (next === existing) return false;
      yield* documents.writeText(target.path, next);
      return true;
    });
    const remove = Effect.fn("AgentInstructionManagedBlockService.remove")(function* (
      target: AgentInstructionTarget,
    ) {
      if (!target.existed) return false;
      const existing = yield* documents.readText(target.path);
      if (!managedBlockPattern().test(existing)) return false;
      const next = existing
        .replace(managedBlockPattern(), "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (next === existing.trim()) return false;
      yield* documents.writeText(target.path, next ? `${next}\n` : "");
      return true;
    });
    return { remove, upsert } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionManagedBlockService,
    AgentInstructionManagedBlockService.make,
  );
}

export class AgentInstructionDocumentsService extends Context.Service<
  AgentInstructionDocumentsService,
  {
    readonly isDirectory: (path: string) => Effect.Effect<boolean>;
    readonly isFile: (path: string) => Effect.Effect<boolean>;
    readonly isIgnored: (path: string) => Effect.Effect<boolean>;
    readonly readText: (path: string) => Effect.Effect<string, RigError>;
    readonly safeRealPath: (path: string) => Effect.Effect<string>;
    readonly removeManagedBlock: (
      target: AgentInstructionTarget,
    ) => Effect.Effect<boolean, RigError>;
    readonly upsertManagedBlock: (
      target: AgentInstructionTarget,
      block: string,
    ) => Effect.Effect<boolean, RigError>;
    readonly writeText: (path: string, content: string) => Effect.Effect<void, RigError>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionDocumentsService", {
  make: Effect.gen(function* () {
    const storage = yield* AgentInstructionDocumentStorageService;
    const blocks = yield* AgentInstructionManagedBlockService;
    const isDirectory = Effect.fn("AgentInstructionDocumentsService.isDirectory")(function* (
      path: string,
    ) {
      return yield* storage.isDirectory(path);
    });
    const isFile = Effect.fn("AgentInstructionDocumentsService.isFile")(function* (path: string) {
      return yield* storage.isFile(path);
    });
    const isIgnored = Effect.fn("AgentInstructionDocumentsService.isIgnored")(function* (
      path: string,
    ) {
      return yield* storage.isIgnored(path);
    });
    const readText = Effect.fn("AgentInstructionDocumentsService.readText")(function* (
      path: string,
    ) {
      return yield* storage.readText(path);
    });
    const safeRealPath = Effect.fn("AgentInstructionDocumentsService.safeRealPath")(function* (
      path: string,
    ) {
      return yield* storage.safeRealPath(path);
    });
    const removeManagedBlock = Effect.fn("AgentInstructionDocumentsService.removeManagedBlock")(
      function* (target: AgentInstructionTarget) {
        return yield* blocks.remove(target);
      },
    );
    const upsertManagedBlock = Effect.fn("AgentInstructionDocumentsService.upsertManagedBlock")(
      function* (target: AgentInstructionTarget, block: string) {
        return yield* blocks.upsert(target, block);
      },
    );
    const writeText = Effect.fn("AgentInstructionDocumentsService.writeText")(function* (
      path: string,
      content: string,
    ) {
      yield* storage.writeText(path, content);
    });
    return {
      isDirectory,
      isFile,
      isIgnored,
      readText,
      safeRealPath,
      removeManagedBlock,
      upsertManagedBlock,
      writeText,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionDocumentsService,
    AgentInstructionDocumentsService.make,
  );
}

const agentInstructionManagedBlockLayer = AgentInstructionManagedBlockService.layer.pipe(
  Layer.provide(AgentInstructionDocumentStorageService.layer),
);
export const agentInstructionDocumentsLayer = AgentInstructionDocumentsService.layer.pipe(
  Layer.provide(
    Layer.merge(AgentInstructionDocumentStorageService.layer, agentInstructionManagedBlockLayer),
  ),
);
