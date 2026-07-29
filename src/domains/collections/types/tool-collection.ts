import type { z } from "zod";

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
  list(options?: ListOptions): Promise<{ entries: CollectionEntry<T>[]; total: number }>;
  search(query: string, options?: { limit?: number }): Promise<{ entries: SearchResult<T>[] }>;
  count(where?: Record<string, unknown>): Promise<number>;
  getCollection(filter?: (entry: CollectionEntry<T>) => boolean): Promise<CollectionEntry<T>[]>;
  clear(): Promise<void>;
};

export type DocRow = {
  id: string;
  data_json: string;
  body: string;
  created_at: string;
  updated_at: string;
  file_mtime: number;
};

export type CollectionFileMetadata = { mtimeMs: number; ctimeMs: number; size: number };

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
  listDocs(options: ListOptions): { rows: DocRow[]; total: number };
  searchDocs(query: string, limit: number): DocRow[];
  countDocs(where?: Record<string, unknown>): number;
  allIds(): string[];
  clearAll(): void;
  close(): void;
}

export type ManagedCollectionHandle = CollectionHandle<any> & {
  init(): Promise<void>;
  close(): void;
};
