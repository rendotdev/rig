import type { CollectionEntry, CollectionIndexInterface, DocRow, ListOptions } from "./collection";

/**
 * In-memory implementation of CollectionIndexInterface for testing.
 * Uses plain Maps and array filtering instead of SQLite/FTS5.
 */
export class MemoryCollectionIndex implements CollectionIndexInterface {
  private docs = new Map<string, DocRow>();

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
          const actual = data[key];
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
      rows.sort((a, b) => {
        const aData = JSON.parse(a.data_json);
        const bData = JSON.parse(b.data_json);
        const aVal = aData[field] ?? "";
        const bVal = bData[field] ?? "";
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
  }

  close(): void {
    // No-op
  }
}
