import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { BoundedFileLockClass } from "../../config/file-lock";
import { RigErrorClass } from "../../errors/RigError";
import { BunSqliteModuleLoaderClass } from "../../persistence/sqlite/tool-database";
import { CollectionNameClass } from "../../tools/identifiers";
import type { LoadedTool } from "../../tools/types";
import { collectionFieldPathCompiler } from "../domain/field-path";

// ─── Public types ────────────────────────────────────────────────────────────

export type CollectionDefinition<T extends z.ZodObject<any> = z.ZodObject<any>> = {
  schema?: T;
  generateId?: (data: z.input<T>) => string;
};

export type CollectionEntry<T = Record<string, unknown>> = {
  id: string;
  data: T;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchResult<T = Record<string, unknown>> = CollectionEntry<T> & {
  snippet: string;
  rank: number;
};

export type ListOptions = {
  where?: Record<string, unknown>;
  sort?: string;
  limit?: number;
  offset?: number;
};

export type CollectionHandle<T = Record<string, unknown>> = {
  readonly name: string;
  readonly path: string;

  create(entry: { id?: string; data: T; body?: string }): Promise<CollectionEntry<T>>;
  getEntry(id: string): Promise<CollectionEntry<T> | null>;
  update(id: string, patch: { data?: Partial<T>; body?: string }): Promise<CollectionEntry<T>>;
  upsert(entry: { id: string; data: T; body?: string }): Promise<{ id: string; created: boolean }>;
  remove(id: string): Promise<boolean>;

  list(opts?: ListOptions): Promise<{ entries: CollectionEntry<T>[]; total: number }>;
  search(query: string, opts?: { limit?: number }): Promise<{ entries: SearchResult<T>[] }>;
  count(where?: Record<string, unknown>): Promise<number>;

  getCollection(filter?: (entry: CollectionEntry<T>) => boolean): Promise<CollectionEntry<T>[]>;
  clear(): Promise<void>;
};

// ─── Frontmatter parser/serializer ──────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class FrontmatterCodecClass {
  parse(content: string): { data: Record<string, unknown>; body: string } {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return { data: {}, body: content };
    const yaml = match[1]!;
    const body = match[2]!.replace(/^\n/, ""); // strip leading blank line after ---
    return { data: this.parseYaml(yaml), body };
  }

  serialize(data: Record<string, unknown>, body: string): string {
    const yaml = this.serializeYaml(data);
    const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
    return `---\n${yaml}---\n\n${normalizedBody}`;
  }

  private parseYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    // Block context: could be an array or a nested object, decided by first indented line
    let blockBuffer: unknown[] | Record<string, unknown> | null = null;
    let currentArrayObj: Record<string, unknown> | null = null;

    const lines = yaml.split(/\r?\n/);
    for (const line of lines) {
      // Array item line: "  - value" or "  - key: value"
      if (blockBuffer !== null && /^\s+-\s/.test(line)) {
        // Ensure block is an array
        if (!Array.isArray(blockBuffer)) blockBuffer = [];
        // Flush previous object item if any
        if (currentArrayObj !== null) {
          (blockBuffer as unknown[]).push(currentArrayObj);
          currentArrayObj = null;
        }
        const value = line.replace(/^\s+-\s*/, "");
        const objKv = value.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (objKv) {
          currentArrayObj = { [objKv[1]!]: this.parseScalar(objKv[2]!.trim()) };
        } else {
          /* v8 ignore next */
          (blockBuffer as unknown[]).push(this.parseScalar(value));
        }
        continue;
      }

      // Continuation of object item in array: "    key: value" (deeper indent, 4+)
      if (currentArrayObj !== null && /^\s{4,}\S/.test(line)) {
        const kvMatch = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (kvMatch) {
          currentArrayObj[kvMatch[1]!] = this.parseScalar(kvMatch[2]!.trim());
          continue;
        }
      }

      // Nested object property: "  key: value" (2-space indent, no dash)
      /* v8 ignore next */
      if (blockBuffer !== null && /^\s{2}[A-Za-z_]/.test(line) && !/^\s+-/.test(line)) {
        // Ensure block is an object
        if (Array.isArray(blockBuffer) && blockBuffer.length === 0) {
          blockBuffer = {};
        }
        if (!Array.isArray(blockBuffer)) {
          const kvMatch = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          if (kvMatch) {
            (blockBuffer as Record<string, unknown>)[kvMatch[1]!] = this.parseScalar(
              kvMatch[2]!.trim(),
            );
            continue;
          }
        }
      }

      // Flush current array object item
      if (currentArrayObj !== null) {
        /* v8 ignore else -- array items always initialize an array block */
        if (Array.isArray(blockBuffer)) blockBuffer.push(currentArrayObj);
        currentArrayObj = null;
      }

      // Flush block if we hit a top-level key
      if (blockBuffer !== null && currentKey !== null && /^[A-Za-z_]/.test(line)) {
        result[currentKey] = blockBuffer;
        blockBuffer = null;
      }

      // Empty line or comment
      if (!line.trim() || line.trim().startsWith("#")) continue;

      // Top-level key: value
      const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!kvMatch) continue;

      currentKey = kvMatch[1]!;
      const rawValue = kvMatch[2]!.trim();

      if (rawValue === "[]") {
        result[currentKey] = [];
        continue;
      }

      if (rawValue === "") {
        // Start of a block (array or nested object, decided by first child line)
        blockBuffer = [];
        continue;
      }

      // Inline array: [a, b, c]
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const inner = rawValue.slice(1, -1);
        result[currentKey] = inner.split(",").map((s) => this.parseScalar(s.trim()));
        continue;
      }

      result[currentKey] = this.parseScalar(rawValue);
    }

    // Flush trailing
    /* v8 ignore next 3 */
    if (currentArrayObj !== null && Array.isArray(blockBuffer)) {
      blockBuffer.push(currentArrayObj);
    }
    if (blockBuffer !== null && currentKey !== null) {
      result[currentKey] = blockBuffer;
    }

    return result;
  }

  private parseScalar(value: string): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "~" || value === "") return null;
    // Quoted string
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    // Number
    const num = Number(value);
    if (!Number.isNaN(num) && value !== "") return num;
    return value;
  }

  private serializeYaml(data: Record<string, unknown>, indent = ""): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      /* v8 ignore next */
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${indent}${key}: []`);
        } else if (this.isSimpleArray(value)) {
          lines.push(`${indent}${key}: [${value.map((v) => this.serializeScalar(v)).join(", ")}]`);
        } else {
          lines.push(`${indent}${key}:`);
          for (const item of value) {
            /* v8 ignore else -- non-record values are emitted by the simple-array branch */
            if (this.isRecord(item)) {
              const objYaml = this.serializeYaml(item, `${indent}    `);
              const objLines = objYaml.split("\n").filter(Boolean);
              lines.push(`${indent}  - ${objLines[0]!.trim()}`);
              for (const objLine of objLines.slice(1)) {
                lines.push(`${indent}    ${objLine.trim()}`);
              }
            } else {
              /* v8 ignore next */
              lines.push(`${indent}  - ${this.serializeScalar(item)}`);
            }
          }
        }
      } else if (this.isRecord(value)) {
        lines.push(`${indent}${key}:`);
        lines.push(this.serializeYaml(value, `${indent}  `));
      } else {
        lines.push(`${indent}${key}: ${this.serializeScalar(value)}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  private serializeScalar(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number") return String(value);
    const str = String(value);
    // Quote if it contains special chars
    if (/[:{},&*#?|><!%@`\n[\]]/.test(str) || str.includes(": ")) {
      return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return str;
  }

  private isSimpleArray(arr: unknown[]): boolean {
    return arr.every((v) => typeof v !== "object" || v === null);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

// ─── Index interface ────────────────────────────────────────────────────────

export type DocRow = {
  id: string;
  data_json: string;
  body: string;
  created_at: string;
  updated_at: string;
  file_mtime: number;
};

export type CollectionFileMetadata = {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

export type CollectionFileRecord = CollectionFileMetadata & {
  id: string;
  status: "indexed" | "invalid";
};

export interface CollectionIndexInterface {
  open(): Promise<void>;
  upsertDoc(entry: CollectionEntry<Record<string, unknown>>, fileMtime: number): void;
  deleteDoc(id: string): void;
  upsertFile(record: CollectionFileRecord): void;
  deleteFile(id: string): void;
  getFile(id: string): CollectionFileRecord | null;
  allFileIds(): string[];
  getDoc(id: string): DocRow | null;
  listDocs(opts: ListOptions): { rows: DocRow[]; total: number };
  searchDocs(query: string, limit: number): DocRow[];
  countDocs(where?: Record<string, unknown>): number;
  allIds(): string[];
  clearAll(): void;
  close(): void;
}

class CollectionEntryIdClass {
  readonly filePath: string;

  constructor(
    readonly value: string,
    collectionPath: string,
  ) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\")
    ) {
      throw new RigErrorClass("INPUT_ERROR", `Invalid collection entry id: ${value}`, {
        expected: "a non-empty filename without path separators or dot segments",
      });
    }

    const root = resolve(collectionPath);
    const filePath = resolve(root, `${value}.md`);
    /* v8 ignore next 3 -- defense in depth after separator and dot-segment validation */
    if (dirname(filePath) !== root) {
      throw new RigErrorClass(
        "INPUT_ERROR",
        `Collection entry id escapes its collection: ${value}`,
      );
    }
    this.filePath = filePath;
  }
}

class CollectionFileFingerprintClass {
  read(path: string): CollectionFileMetadata {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
  }

  matches(record: CollectionFileRecord | null, metadata: CollectionFileMetadata): boolean {
    return (
      record !== null &&
      record.mtimeMs === metadata.mtimeMs &&
      record.ctimeMs === metadata.ctimeMs &&
      record.size === metadata.size
    );
  }
}

const collectionFileFingerprint = new CollectionFileFingerprintClass();

// ─── SQLite index (production) ──────────────────────────────────────────────

/* v8 ignore start */
type CollectionDatabaseConstructor = new (
  filename: string,
  options?: { create?: boolean; strict?: boolean },
) => Database;

class CollectionIndexCorruptionErrorClass extends Error {}

class SqliteCollectionIndexClass implements CollectionIndexInterface {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly collectionPath: string;
  private readonly sqliteLoader = new BunSqliteModuleLoaderClass();
  private readonly recoveryLock: BoundedFileLockClass;

  constructor(collectionPath: string) {
    this.collectionPath = collectionPath;
    this.dbPath = join(collectionPath, ".index.sqlite");
    this.recoveryLock = new BoundedFileLockClass(this.dbPath);
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (!this.sqliteLoader.available()) {
      throw new RigErrorClass("TOOL_INVALID", "Collections require the Bun SQLite runtime.");
    }
    const Database = await this.sqliteLoader.database();
    try {
      this.initialize(Database);
    } catch (error) {
      this.close();
      if (!this.isRecoverable(error)) throw error;
      await this.recoveryLock.run(() => this.recover(Database));
    }
  }

  private async recover(Database: CollectionDatabaseConstructor): Promise<void> {
    try {
      this.initialize(Database);
      return;
    } catch (error) {
      this.close();
      if (!this.isRecoverable(error)) throw error;
    }

    await this.removeDerivedFiles();
    this.initialize(Database);
  }

  private initialize(Database: CollectionDatabaseConstructor): void {
    this.db = new Database(this.dbPath, { create: true, strict: true });
    try {
      this.db.run("PRAGMA journal_mode = WAL;");
      this.migrate();
      this.validate();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private validate(): void {
    const integrityRows = this.db!.query("PRAGMA quick_check;").all() as Array<
      Record<string, unknown>
    >;
    const integrityResults = integrityRows.flatMap((row) => Object.values(row));
    if (integrityResults.length !== 1 || integrityResults[0] !== "ok") {
      throw new CollectionIndexCorruptionErrorClass(
        `Collection index integrity check failed: ${integrityResults.join(", ")}`,
      );
    }

    try {
      this.db!.query(
        "SELECT id, data_json, body, created_at, updated_at, file_mtime FROM docs LIMIT 0",
      ).all();
      this.db!.query(
        "SELECT id, mtime_ms, ctime_ms, size, status FROM collection_files LIMIT 0",
      ).all();
      this.db!.query("SELECT rowid, id, data_json, body FROM docs_fts LIMIT 0").all();
    } catch (error) {
      throw new CollectionIndexCorruptionErrorClass(
        `Collection index schema is unusable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private isRecoverable(error: unknown): boolean {
    if (error instanceof CollectionIndexCorruptionErrorClass) return true;
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = String(error.code);
    return code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT");
  }

  private async removeDerivedFiles(): Promise<void> {
    await Promise.all(
      [this.dbPath, `${this.dbPath}-shm`, `${this.dbPath}-wal`].map((path) =>
        rm(path, { force: true }),
      ),
    );
  }

  private migrate(): void {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        file_mtime REAL NOT NULL DEFAULT 0
      );
    `);
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS collection_files (
        id TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        ctime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('indexed', 'invalid'))
      );
    `);
    this.db!.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        id, data_json, body,
        content=docs, content_rowid=rowid
      );
    `);
    // Triggers for FTS sync
    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, id, data_json, body)
        VALUES (new.rowid, new.id, new.data_json, new.body);
      END;
    `);
    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, id, data_json, body)
        VALUES ('delete', old.rowid, old.id, old.data_json, old.body);
      END;
    `);
    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, id, data_json, body)
        VALUES ('delete', old.rowid, old.id, old.data_json, old.body);
        INSERT INTO docs_fts(rowid, id, data_json, body)
        VALUES (new.rowid, new.id, new.data_json, new.body);
      END;
    `);
  }

  upsertDoc(entry: CollectionEntry<Record<string, unknown>>, fileMtime: number): void {
    this.db!.query(`
      INSERT INTO docs (id, data_json, body, created_at, updated_at, file_mtime)
      VALUES ($id, $dataJson, $body, $createdAt, $updatedAt, $fileMtime)
      ON CONFLICT(id) DO UPDATE SET
        data_json = excluded.data_json,
        body = excluded.body,
        updated_at = excluded.updated_at,
        file_mtime = excluded.file_mtime
    `).run({
      id: entry.id,
      dataJson: JSON.stringify(entry.data),
      body: entry.body,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      fileMtime,
    });
  }

  deleteDoc(id: string): void {
    this.db!.query("DELETE FROM docs WHERE id = $id").run({ id });
  }

  upsertFile(record: CollectionFileRecord): void {
    this.db!.query(`
      INSERT INTO collection_files (id, mtime_ms, ctime_ms, size, status)
      VALUES ($id, $mtimeMs, $ctimeMs, $size, $status)
      ON CONFLICT(id) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        ctime_ms = excluded.ctime_ms,
        size = excluded.size,
        status = excluded.status
    `).run(record);
  }

  deleteFile(id: string): void {
    this.db!.query("DELETE FROM collection_files WHERE id = $id").run({ id });
  }

  getFile(id: string): CollectionFileRecord | null {
    const row = this.db!.query(`
      SELECT id, mtime_ms, ctime_ms, size, status
      FROM collection_files
      WHERE id = $id
    `).get({ id }) as {
      id: string;
      mtime_ms: number;
      ctime_ms: number;
      size: number;
      status: "indexed" | "invalid";
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      mtimeMs: row.mtime_ms,
      ctimeMs: row.ctime_ms,
      size: row.size,
      status: row.status,
    };
  }

  allFileIds(): string[] {
    const rows = this.db!.query("SELECT id FROM collection_files").all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  getDoc(id: string): DocRow | null {
    return this.db!.query("SELECT * FROM docs WHERE id = $id").get({ id }) as DocRow | null;
  }

  listDocs(opts: ListOptions): { rows: DocRow[]; total: number } {
    let whereClause = "";
    const params: Record<string, unknown> = {};

    if (opts.where && Object.keys(opts.where).length > 0) {
      const conditions: string[] = [];
      for (const [index, [key, value]] of Object.entries(opts.where).entries()) {
        const field = collectionFieldPathCompiler.compile(key);
        const paramName = `where_${index}`;
        conditions.push(`json_extract(data_json, '${field.sqliteJsonPath}') = $${paramName}`);
        params[paramName] = typeof value === "object" ? JSON.stringify(value) : value;
      }
      whereClause = `WHERE ${conditions.join(" AND ")}`;
    }

    let orderClause = "ORDER BY updated_at DESC";
    if (opts.sort) {
      const desc = opts.sort.startsWith("-");
      const field = desc ? opts.sort.slice(1) : opts.sort;
      const compiledField = collectionFieldPathCompiler.compile(field);
      orderClause = `ORDER BY json_extract(data_json, '${compiledField.sqliteJsonPath}') ${desc ? "DESC" : "ASC"}`;
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const countRow = this.db!.query(`SELECT COUNT(*) as cnt FROM docs ${whereClause}`).get(
      params as any,
    ) as { cnt: number };

    const rows = this.db!.query(
      `SELECT * FROM docs ${whereClause} ${orderClause} LIMIT $limit OFFSET $offset`,
    ).all({ ...params, limit, offset } as any) as DocRow[];

    return { rows, total: countRow.cnt };
  }

  searchDocs(query: string, limit: number): DocRow[] {
    // Use FTS5 MATCH for full-text search, join back to docs for full row
    const rows = this.db!.query(`
      SELECT docs.*, docs_fts.rank
      FROM docs_fts
      JOIN docs ON docs.id = docs_fts.id
      WHERE docs_fts MATCH $query
      ORDER BY docs_fts.rank
      LIMIT $limit
    `).all({ query, limit }) as (DocRow & { rank: number })[];
    return rows;
  }

  countDocs(where?: Record<string, unknown>): number {
    if (!where || Object.keys(where).length === 0) {
      const row = this.db!.query("SELECT COUNT(*) as cnt FROM docs").get() as { cnt: number };
      return row.cnt;
    }
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    for (const [index, [key, value]] of Object.entries(where).entries()) {
      const field = collectionFieldPathCompiler.compile(key);
      const paramName = `where_${index}`;
      conditions.push(`json_extract(data_json, '${field.sqliteJsonPath}') = $${paramName}`);
      params[paramName] = typeof value === "object" ? JSON.stringify(value) : value;
    }
    const row = this.db!.query(
      `SELECT COUNT(*) as cnt FROM docs WHERE ${conditions.join(" AND ")}`,
    ).get(params as any) as { cnt: number };
    return row.cnt;
  }

  allIds(): string[] {
    const rows = this.db!.query("SELECT id FROM docs").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  clearAll(): void {
    this.db!.run("DELETE FROM docs");
    this.db!.run("DELETE FROM collection_files");
  }

  close(): void {
    this.db?.close(false);
    this.db = null;
  }
}
/* v8 ignore stop */

// ─── Collection handle implementation ───────────────────────────────────────

export class CollectionHandleImplClass<
  T extends Record<string, unknown>,
> implements CollectionHandle<T> {
  readonly name: string;
  readonly path: string;
  private readonly schema: z.ZodObject<any> | undefined;
  private readonly generateId: ((data: T) => string) | undefined;
  private readonly index: CollectionIndexInterface;
  private readonly codec = new FrontmatterCodecClass();
  private reconciled = false;

  constructor(
    name: string,
    collectionPath: string,
    definition: CollectionDefinition,
    index?: CollectionIndexInterface,
  ) {
    this.name = name;
    this.path = collectionPath;
    this.schema = definition.schema;
    this.generateId = definition.generateId as ((data: T) => string) | undefined;
    /* v8 ignore next */
    this.index = index ?? new SqliteCollectionIndexClass(collectionPath);
  }

  async init(): Promise<void> {
    await mkdir(this.path, { recursive: true });
    await this.index.open();
    await this.reconcile();
  }

  async create(entry: { id?: string; data: T; body?: string }): Promise<CollectionEntry<T>> {
    const data = this.validate(entry.data);
    const id = entry.id ?? this.deriveId(data);
    if (id === undefined) {
      throw new RigErrorClass(
        "INPUT_ERROR",
        "Collection entry needs an id (provide one or define generateId).",
      );
    }

    const entryId = new CollectionEntryIdClass(id, this.path);
    const filePath = entryId.filePath;
    if (existsSync(filePath)) {
      throw new RigErrorClass("INPUT_ERROR", `Collection entry already exists: ${id}`, { id });
    }

    const now = new Date().toISOString();
    const doc: CollectionEntry<T> = {
      id,
      data,
      body: entry.body ?? "",
      createdAt: now,
      updatedAt: now,
    };

    await this.writeToDisk(doc);
    return doc;
  }

  async getEntry(id: string): Promise<CollectionEntry<T> | null> {
    const entryId = new CollectionEntryIdClass(id, this.path);
    const filePath = entryId.filePath;
    if (!existsSync(filePath)) return null;
    return this.readFromDisk(entryId.value);
  }

  async update(
    id: string,
    patch: { data?: Partial<T>; body?: string },
  ): Promise<CollectionEntry<T>> {
    const existing = await this.getEntry(id);
    if (!existing) {
      throw new RigErrorClass("INPUT_ERROR", `Collection entry not found: ${id}`, { id });
    }

    const mergedData = patch.data
      ? this.validate({ ...existing.data, ...patch.data } as T)
      : existing.data;

    const doc: CollectionEntry<T> = {
      id,
      data: mergedData,
      body: patch.body !== undefined ? patch.body : existing.body,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await this.writeToDisk(doc);
    return doc;
  }

  async upsert(entry: {
    id: string;
    data: T;
    body?: string;
  }): Promise<{ id: string; created: boolean }> {
    const entryId = new CollectionEntryIdClass(entry.id, this.path);
    const exists = existsSync(entryId.filePath);
    if (exists) {
      await this.update(entry.id, { data: entry.data, body: entry.body });
      return { id: entry.id, created: false };
    }
    await this.create(entry);
    return { id: entry.id, created: true };
  }

  async remove(id: string): Promise<boolean> {
    const entryId = new CollectionEntryIdClass(id, this.path);
    const filePath = entryId.filePath;
    if (!existsSync(filePath)) return false;
    await unlink(filePath);
    this.index.deleteDoc(id);
    this.index.deleteFile(id);
    return true;
  }

  async list(opts: ListOptions = {}): Promise<{ entries: CollectionEntry<T>[]; total: number }> {
    const { rows, total } = this.index.listDocs(opts);
    return {
      entries: rows.map((row) => this.rowToEntry(row)),
      total,
    };
  }

  async search(query: string, opts?: { limit?: number }): Promise<{ entries: SearchResult<T>[] }> {
    const limit = opts?.limit ?? 10;
    const rows = this.index.searchDocs(query, limit) as (DocRow & { rank: number })[];
    return {
      entries: rows.map((row) => ({
        ...this.rowToEntry(row),
        snippet: this.extractSnippet(row.body, query),
        rank: row.rank,
      })),
    };
  }

  async count(where?: Record<string, unknown>): Promise<number> {
    return this.index.countDocs(where);
  }

  async getCollection(
    filter?: (entry: CollectionEntry<T>) => boolean,
  ): Promise<CollectionEntry<T>[]> {
    const { entries } = await this.list({ limit: 100_000 });
    return filter ? entries.filter(filter) : entries;
  }

  async clear(): Promise<void> {
    const ids = [...new Set([...this.index.allIds(), ...this.index.allFileIds()])];
    await Promise.all(
      ids.map(async (id) => {
        const filePath = this.filePath(id);
        /* v8 ignore next */
        if (existsSync(filePath)) await unlink(filePath);
      }),
    );
    this.index.clearAll();
  }

  close(): void {
    this.index.close();
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private validate(data: unknown): T {
    if (!this.schema) return data as T;
    const result = this.schema.safeParse(data);
    if (!result.success) {
      throw new RigErrorClass("VALIDATION_ERROR", "Collection entry data is invalid.", {
        errors: result.error.flatten(),
      });
    }
    return result.data as T;
  }

  private deriveId(data: T): string | undefined {
    if (this.generateId) return this.generateId(data);
    // Fallback: try common fields
    const candidate =
      (data as Record<string, unknown>).id ??
      (data as Record<string, unknown>).slug ??
      (data as Record<string, unknown>).title;
    if (typeof candidate === "string") return this.slugify(candidate);
    return undefined;
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private filePath(id: string): string {
    return new CollectionEntryIdClass(id, this.path).filePath;
  }

  private async writeToDisk(doc: CollectionEntry<T>): Promise<void> {
    const content = this.codec.serialize(doc.data as Record<string, unknown>, doc.body);
    const filePath = this.filePath(doc.id);
    await writeFile(filePath, content, "utf8");
    const metadata = collectionFileFingerprint.read(filePath);
    this.index.upsertDoc(doc as CollectionEntry<Record<string, unknown>>, metadata.mtimeMs);
    this.index.upsertFile({ id: doc.id, status: "indexed", ...metadata });
  }

  private async readFromDisk(id: string): Promise<CollectionEntry<T>> {
    const filePath = this.filePath(id);
    const content = await readFile(filePath, "utf8");
    const { data, body } = this.codec.parse(content);
    const stat = statSync(filePath);

    // Check index for timestamps
    const row = this.index.getDoc(id);
    /* v8 ignore next 3 */
    const createdAt = row?.created_at ?? stat.birthtime.toISOString();
    const updatedAt = row?.updated_at ?? stat.mtime.toISOString();

    return {
      id,
      data: (this.schema ? this.validate(data) : data) as T,
      body,
      createdAt,
      updatedAt,
    };
  }

  /* v8 ignore start */
  private async reconcile(): Promise<void> {
    if (this.reconciled) return;
    this.reconciled = true;

    // Stat every Markdown file, then parse only additions and metadata changes.
    const files = readdirSync(this.path).filter((f) => f.endsWith(".md"));
    const knownIds = new Set([...this.index.allIds(), ...this.index.allFileIds()]);
    const fileIds = new Set<string>();

    await Promise.all(
      files.map(async (file) => {
        const id = file.slice(0, -3); // remove .md
        fileIds.add(id);
        const filePath = join(this.path, file);
        const metadata = collectionFileFingerprint.read(filePath);
        const tracked = this.index.getFile(id);
        if (collectionFileFingerprint.matches(tracked, metadata)) return;

        // File is newer or missing from index: re-index
        try {
          const content = await readFile(filePath, "utf8");
          const { data, body } = this.codec.parse(content);
          const stableMetadata = collectionFileFingerprint.read(filePath);
          const indexed = this.index.getDoc(id);
          const entry: CollectionEntry<Record<string, unknown>> = {
            id,
            data: this.schema ? this.validate(data) : data,
            body,
            createdAt: indexed?.created_at ?? new Date(stableMetadata.ctimeMs).toISOString(),
            updatedAt: new Date(stableMetadata.mtimeMs).toISOString(),
          };
          this.index.upsertDoc(entry, stableMetadata.mtimeMs);
          this.index.upsertFile({ id, status: "indexed", ...stableMetadata });
        } catch {
          this.index.deleteDoc(id);
          this.index.upsertFile({ id, status: "invalid", ...metadata });
        }
      }),
    );

    // Remove index entries and fingerprints for deleted files.
    for (const id of knownIds) {
      if (!fileIds.has(id)) {
        this.index.deleteDoc(id);
        this.index.deleteFile(id);
      }
    }
  }
  /* v8 ignore stop */

  private rowToEntry(row: DocRow): CollectionEntry<T> {
    return {
      id: row.id,
      data: JSON.parse(row.data_json) as T,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private extractSnippet(body: string, query: string): string {
    const words = query.toLowerCase().split(/\s+/);
    const lines = body.split("\n");
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (words.some((w) => lower.includes(w))) {
        return line.slice(0, 200);
      }
    }
    return body.slice(0, 150);
  }
}

// ─── Service: creates handles for a loaded tool ─────────────────────────────

export class ToolCollectionServiceClass {
  constructor(private readonly handleFactory = collectionHandleFactory) {}

  async setup(tool: LoadedTool): Promise<Record<string, CollectionHandle<any>> | undefined> {
    const definitions = (tool.definition as ToolDefinitionWithCollections).collections;
    if (!definitions || Object.keys(definitions).length === 0) return undefined;

    const toolDir = dirname(tool.path);
    const handles: Record<string, CollectionHandle<any>> = {};

    const results = await Promise.allSettled(
      Object.entries(definitions).map(async ([name, def]) => {
        const collectionName = new CollectionNameClass(name);
        const collectionPath = join(toolDir, collectionName.value);
        const handle = this.handleFactory.create(collectionName.value, collectionPath, def ?? {});
        try {
          await handle.init();
        } catch (error) {
          handle.close();
          throw error;
        }
        handles[name] = handle;
      }),
    );

    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      this.close(handles);
      throw failure.reason;
    }

    return handles;
  }

  close(handles: Record<string, CollectionHandle<any>> | undefined): void {
    if (!handles) return;
    for (const handle of Object.values(handles)) {
      (handle as CollectionHandleImplClass<any>).close();
    }
  }
}

export type ManagedCollectionHandle = CollectionHandle<any> & {
  init(): Promise<void>;
  close(): void;
};

export interface CollectionHandleFactory {
  create(name: string, path: string, definition: CollectionDefinition): ManagedCollectionHandle;
}

export class CollectionHandleFactoryClass implements CollectionHandleFactory {
  create(name: string, path: string, definition: CollectionDefinition): ManagedCollectionHandle {
    return new CollectionHandleImplClass(name, path, definition);
  }
}

export const collectionHandleFactory = new CollectionHandleFactoryClass();

// Internal type for accessing collections on the definition
type ToolDefinitionWithCollections = {
  collections?: Record<string, CollectionDefinition | undefined>;
};
