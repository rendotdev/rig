import type {
  CollectionEntry,
  CollectionFileRecord,
  CollectionIndexInterface,
  DocRow,
  ListOptions,
} from "../application/tool-collection";
import { collectionFieldPathCompiler } from "../domain/field-path";

/**
 * In-memory implementation of CollectionIndexInterface for testing.
 * Uses plain Maps and array filtering instead of SQLite/FTS5.
 */
export class MemoryCollectionIndexClass implements CollectionIndexInterface {
  private docs = new Map<string, DocRow>();
  private files = new Map<string, CollectionFileRecord>();

  async withExclusiveInitialization<T>(params: { operation: () => Promise<T> }): Promise<T> {
    return params.operation();
  }

  async open(): Promise<void> {
    // No-op for memory index
  }

  upsertDoc(entry: CollectionEntry<Record<string, unknown>>, fileMtime: number): void {
    this.docs.set(entry.id, {
      id: entry.id,
      data_json: JSON.stringify(entry.data),
      body: entry.body,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      file_mtime: fileMtime,
    });
  }

  deleteDoc(id: string): void {
    this.docs.delete(id);
  }

  upsertFile(record: CollectionFileRecord): void {
    this.files.set(record.id, record);
  }

  deleteFile(id: string): void {
    this.files.delete(id);
  }

  getFile(id: string): CollectionFileRecord | null {
    return this.files.get(id) ?? null;
  }

  allFileIds(): string[] {
    return [...this.files.keys()];
  }

  getDoc(id: string): DocRow | null {
    return this.docs.get(id) ?? null;
  }

  listDocs(opts: ListOptions): { rows: DocRow[]; total: number } {
    let rows = [...this.docs.values()];

    // Apply where filter
    if (opts.where && Object.keys(opts.where).length > 0) {
      rows = rows.filter((row) => {
        const data = JSON.parse(row.data_json);
        return Object.entries(opts.where!).every(([key, value]) => {
          const actual = collectionFieldPathCompiler.compile(key).read(data);
          if (typeof value === "object" && value !== null) {
            return JSON.stringify(actual) === JSON.stringify(value);
          }
          return actual === value;
        });
      });
    }

    const total = rows.length;

    // Apply sort
    if (opts.sort) {
      const desc = opts.sort.startsWith("-");
      const field = desc ? opts.sort.slice(1) : opts.sort;
      const compiledField = collectionFieldPathCompiler.compile(field);
      rows.sort((a, b) => {
        const aData = JSON.parse(a.data_json);
        const bData = JSON.parse(b.data_json);
        const aVal = compiledField.read(aData) ?? "";
        const bVal = compiledField.read(bData) ?? "";
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return desc ? -cmp : cmp;
      });
    } else {
      // Default: order by updated_at desc
      rows.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    }

    // Apply limit/offset
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    rows = rows.slice(offset, offset + limit);

    return { rows, total };
  }

  searchDocs(query: string, limit: number): DocRow[] {
    const words = query.toLowerCase().split(/\s+/);
    const scored: { row: DocRow; rank: number }[] = [];

    for (const row of this.docs.values()) {
      const text = `${row.id} ${row.data_json} ${row.body}`.toLowerCase();
      const matches = words.filter((w) => text.includes(w)).length;
      if (matches > 0) {
        scored.push({
          row: { ...row, rank: -matches } as DocRow & { rank: number },
          rank: -matches,
        });
      }
    }

    scored.sort((a, b) => a.rank - b.rank);
    return scored.slice(0, limit).map((s) => s.row);
  }

  countDocs(where?: Record<string, unknown>): number {
    if (!where || Object.keys(where).length === 0) return this.docs.size;
    return this.listDocs({ where }).total;
  }

  allIds(): string[] {
    return [...this.docs.keys()];
  }

  clearAll(): void {
    this.docs.clear();
    this.files.clear();
  }

  close(): void {
    // No-op
  }
}
