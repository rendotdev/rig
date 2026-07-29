import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../../providers/errors/rig-error";
import type {
  CollectionEntry,
  CollectionFileRecord,
  CollectionIndexInterface,
  DocRow,
  ListOptions,
} from "../../types/tool-collection";

const compileFieldPath = (value: string) => {
  const segments = value.split(".");
  const hasInvalidSegment = segments.some((part) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part));
  const isInvalidPath = value.length === 0 || hasInvalidSegment;
  if (isInvalidPath) {
    throw new RigError({
      code: "INPUT_ERROR",
      message: `Invalid collection field path: ${value}`,
      details: { expected: "dot-separated field names beginning with a letter or underscore" },
    });
  }
  const read = (input: unknown) => {
    let current = input;
    for (const segment of segments) {
      const isMissingSegment =
        typeof current !== "object" || current === null || !(segment in current);
      if (isMissingSegment) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  };
  return { read } as const;
};

const createListDocs = (docs: ReadonlyMap<string, DocRow>) => (options: ListOptions) => {
  let rows = [...docs.values()];
  const filters = Object.entries(options.where ?? {}).map(([path, value]) => ({
    field: compileFieldPath(path),
    value,
  }));
  if (filters.length > 0) {
    rows = rows.filter((row) => {
      const data: unknown = JSON.parse(row.data_json);
      return filters.every(({ field, value }) => {
        const actual = field.read(data);
        return typeof value === "object" && value !== null
          ? JSON.stringify(actual) === JSON.stringify(value)
          : actual === value;
      });
    });
  }
  const total = rows.length;
  if (options.sort) {
    const descending = options.sort.startsWith("-");
    const field = compileFieldPath(descending ? options.sort.slice(1) : options.sort);
    rows.sort((left, right) => {
      const leftValue = field.read(JSON.parse(left.data_json)) ?? "";
      const rightValue = field.read(JSON.parse(right.data_json)) ?? "";
      const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return descending ? -comparison : comparison;
    });
  } else {
    rows.sort((left, right) => (right.updated_at > left.updated_at ? 1 : -1));
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  return { rows: rows.slice(offset, offset + limit), total };
};

const createSearchDocs = (docs: ReadonlyMap<string, DocRow>) => (query: string, limit: number) => {
  const words = query.toLowerCase().split(/\s+/);
  const scored: { row: DocRow; rank: number }[] = [];
  for (const row of docs.values()) {
    const text = `${row.id} ${row.data_json} ${row.body}`.toLowerCase();
    const matches = words.filter((word) => text.includes(word)).length;
    if (matches > 0) {
      scored.push({ row: { ...row, rank: -matches } as DocRow & { rank: number }, rank: -matches });
    }
  }
  scored.sort((left, right) => left.rank - right.rank);
  return scored.slice(0, limit).map((entry) => entry.row);
};

const createMemoryCollectionIndex = (): CollectionIndexInterface => {
  const docs = new Map<string, DocRow>();
  const files = new Map<string, CollectionFileRecord>();
  const listDocs = createListDocs(docs);
  const upsertDoc = (entry: CollectionEntry<Record<string, unknown>>, fileMtime: number) => {
    docs.set(entry.id, {
      id: entry.id,
      data_json: JSON.stringify(entry.data),
      body: entry.body,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      file_mtime: fileMtime,
    });
  };
  return {
    open: async () => undefined,
    upsertDoc,
    deleteDoc: (id) => void docs.delete(id),
    upsertFile: (record) => void files.set(record.id, record),
    deleteFile: (id) => void files.delete(id),
    getFile: (id) => files.get(id) ?? null,
    allFileIds: () => [...files.keys()],
    getDoc: (id) => docs.get(id) ?? null,
    listDocs,
    searchDocs: createSearchDocs(docs),
    countDocs: (where) =>
      !where || Object.keys(where).length === 0 ? docs.size : listDocs({ where }).total,
    allIds: () => [...docs.keys()],
    clearAll: () => {
      docs.clear();
      files.clear();
    },
    close: () => undefined,
  };
};

export class MemoryCollectionIndexService extends Context.Service<
  MemoryCollectionIndexService,
  {
    readonly create: Effect.Effect<CollectionIndexInterface>;
  }
>()("@rendotdev/rig/collections/MemoryCollectionIndexService", {
  make: Effect.gen(function* () {
    const create = Effect.sync(createMemoryCollectionIndex).pipe(
      Effect.withSpan("MemoryCollectionIndexService.create"),
    );

    return { create } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    MemoryCollectionIndexService,
    MemoryCollectionIndexService.make,
  );
}
