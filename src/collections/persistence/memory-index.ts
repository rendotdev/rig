import { defineService } from "../../define";
import type {
  CollectionEntry,
  CollectionFileRecord,
  CollectionIndexInterface,
  DocRow,
  ListOptions,
} from "../application/tool-collection";
import { collectionFieldPathCompiler } from "../domain/field-path";

async function runMemoryExclusiveOperation<T>(params: { operation: () => Promise<T> }): Promise<T> {
  return await params.operation();
}

async function openMemoryIndex(_params: {}): Promise<void> {}

function closeMemoryIndex(_params: {}): void {}

export class MemoryCollectionIndexService extends defineService({
  params: {},
  deps: {},
}) {
  private readonly docs = new Map<string, DocRow>();
  private readonly files = new Map<string, CollectionFileRecord>();

  public upsertDoc(params: {
    entry: CollectionEntry<Record<string, unknown>>;
    fileMtime: number;
  }): void {
    this.docs.set(params.entry.id, {
      id: params.entry.id,
      data_json: JSON.stringify(params.entry.data),
      body: params.entry.body,
      created_at: params.entry.createdAt,
      updated_at: params.entry.updatedAt,
      file_mtime: params.fileMtime,
    });
  }

  public deleteDoc(params: { id: string }): void {
    this.docs.delete(params.id);
  }

  public upsertFile(params: { record: CollectionFileRecord }): void {
    this.files.set(params.record.id, params.record);
  }

  public deleteFile(params: { id: string }): void {
    this.files.delete(params.id);
  }

  public getFile(params: { id: string }): CollectionFileRecord | null {
    return this.files.get(params.id) ?? null;
  }

  public allFileIds(_params: {}): string[] {
    return [...this.files.keys()];
  }

  public getDoc(params: { id: string }): DocRow | null {
    return this.docs.get(params.id) ?? null;
  }

  public listDocs(params: { options: ListOptions }): { rows: DocRow[]; total: number } {
    const options = params.options;
    let rows = [...this.docs.values()];

    if (options.where && Object.keys(options.where).length > 0) {
      rows = rows.filter(function matchesWhere(row) {
        const data: unknown = JSON.parse(row.data_json);
        return Object.entries(options.where!).every(function matchesEntry([key, value]) {
          const actual = collectionFieldPathCompiler.compile(key).read(data);
          if (typeof value === "object" && value !== null) {
            return JSON.stringify(actual) === JSON.stringify(value);
          }
          return actual === value;
        });
      });
    }

    const total = rows.length;

    if (options.sort) {
      const descending = options.sort.startsWith("-");
      const field = descending ? options.sort.slice(1) : options.sort;
      const compiledField = collectionFieldPathCompiler.compile(field);
      rows.sort(function compareRows(left, right) {
        const leftData: unknown = JSON.parse(left.data_json);
        const rightData: unknown = JSON.parse(right.data_json);
        const leftValue = compiledField.read(leftData) ?? "";
        const rightValue = compiledField.read(rightData) ?? "";
        const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
        return descending ? -comparison : comparison;
      });
    } else {
      rows.sort(function compareUpdatedAt(left, right) {
        return right.updated_at > left.updated_at ? 1 : -1;
      });
    }

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    rows = rows.slice(offset, offset + limit);
    return { rows, total };
  }

  public searchDocs(params: { query: string; limit: number }): DocRow[] {
    const words = params.query.toLowerCase().split(/\s+/);
    const scored: { row: DocRow; rank: number }[] = [];

    for (const row of this.docs.values()) {
      const text = `${row.id} ${row.data_json} ${row.body}`.toLowerCase();
      const matches = words.filter(function matchesWord(word) {
        return text.includes(word);
      }).length;
      if (matches > 0) {
        scored.push({
          row: { ...row, rank: -matches } as DocRow & { rank: number },
          rank: -matches,
        });
      }
    }

    scored.sort(function compareRank(left, right) {
      return left.rank - right.rank;
    });
    return scored.slice(0, params.limit).map(function scoredRow(entry) {
      return entry.row;
    });
  }

  public countDocs(params: { where?: Record<string, unknown> }): number {
    if (!params.where || Object.keys(params.where).length === 0) return this.docs.size;
    return this.listDocs({ options: { where: params.where } }).total;
  }

  public allIds(_params: {}): string[] {
    return [...this.docs.keys()];
  }

  public clearAll(_params: {}): void {
    this.docs.clear();
    this.files.clear();
  }

  public withExclusiveInitialization<T>(params: { operation: () => Promise<T> }): Promise<T> {
    return runMemoryExclusiveOperation(params);
  }

  public open(params: {}): Promise<void> {
    return openMemoryIndex(params);
  }

  public close(params: {}): void {
    closeMemoryIndex(params);
  }
}

export type MemoryCollectionIndexClass = CollectionIndexInterface;

type MemoryCollectionIndexConstructor = {
  new (): MemoryCollectionIndexClass;
  readonly prototype: MemoryCollectionIndexClass;
};

type MemoryCollectionIndexAdapter = MemoryCollectionIndexClass & {
  readonly resource: MemoryCollectionIndexService;
};

const MemoryCollectionIndexClassAdapter = function constructMemoryCollectionIndex(
  this: MemoryCollectionIndexAdapter,
): void {
  Object.defineProperty(this, "resource", {
    value: new MemoryCollectionIndexService(),
  });
};
Object.defineProperty(MemoryCollectionIndexClassAdapter, "name", {
  value: "MemoryCollectionIndexClass",
});
Object.defineProperties(MemoryCollectionIndexClassAdapter.prototype, {
  withExclusiveInitialization: {
    configurable: true,
    value: function withExclusiveInitialization<T>(
      this: MemoryCollectionIndexAdapter,
      params: { operation: () => Promise<T> },
    ) {
      return this.resource.withExclusiveInitialization(params);
    },
    writable: true,
  },
  open: {
    configurable: true,
    value: function open(this: MemoryCollectionIndexAdapter) {
      return this.resource.open({});
    },
    writable: true,
  },
  upsertDoc: {
    configurable: true,
    value: function upsertDoc(
      this: MemoryCollectionIndexAdapter,
      entry: CollectionEntry<Record<string, unknown>>,
      fileMtime: number,
    ) {
      return this.resource.upsertDoc({ entry, fileMtime });
    },
    writable: true,
  },
  deleteDoc: {
    configurable: true,
    value: function deleteDoc(this: MemoryCollectionIndexAdapter, id: string) {
      return this.resource.deleteDoc({ id });
    },
    writable: true,
  },
  upsertFile: {
    configurable: true,
    value: function upsertFile(this: MemoryCollectionIndexAdapter, record: CollectionFileRecord) {
      return this.resource.upsertFile({ record });
    },
    writable: true,
  },
  deleteFile: {
    configurable: true,
    value: function deleteFile(this: MemoryCollectionIndexAdapter, id: string) {
      return this.resource.deleteFile({ id });
    },
    writable: true,
  },
  getFile: {
    configurable: true,
    value: function getFile(this: MemoryCollectionIndexAdapter, id: string) {
      return this.resource.getFile({ id });
    },
    writable: true,
  },
  allFileIds: {
    configurable: true,
    value: function allFileIds(this: MemoryCollectionIndexAdapter) {
      return this.resource.allFileIds({});
    },
    writable: true,
  },
  getDoc: {
    configurable: true,
    value: function getDoc(this: MemoryCollectionIndexAdapter, id: string) {
      return this.resource.getDoc({ id });
    },
    writable: true,
  },
  listDocs: {
    configurable: true,
    value: function listDocs(this: MemoryCollectionIndexAdapter, options: ListOptions) {
      return this.resource.listDocs({ options });
    },
    writable: true,
  },
  searchDocs: {
    configurable: true,
    value: function searchDocs(this: MemoryCollectionIndexAdapter, query: string, limit: number) {
      return this.resource.searchDocs({ query, limit });
    },
    writable: true,
  },
  countDocs: {
    configurable: true,
    value: function countDocs(this: MemoryCollectionIndexAdapter, where?: Record<string, unknown>) {
      return this.resource.countDocs({ where });
    },
    writable: true,
  },
  allIds: {
    configurable: true,
    value: function allIds(this: MemoryCollectionIndexAdapter) {
      return this.resource.allIds({});
    },
    writable: true,
  },
  clearAll: {
    configurable: true,
    value: function clearAll(this: MemoryCollectionIndexAdapter) {
      return this.resource.clearAll({});
    },
    writable: true,
  },
  close: {
    configurable: true,
    value: function close(this: MemoryCollectionIndexAdapter) {
      return this.resource.close({});
    },
    writable: true,
  },
});

export const MemoryCollectionIndexClass =
  MemoryCollectionIndexClassAdapter as unknown as MemoryCollectionIndexConstructor;
