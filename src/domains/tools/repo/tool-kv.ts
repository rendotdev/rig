import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { LoadedTool, RigToolKvStore } from "../types/tool-types";
import {
  type DatabaseConstructor,
  SqlitePlatformService,
} from "../../../providers/database/sqlite";

type KvRow = { value_json: string };
export type ManagedRigToolKvStore = RigToolKvStore & { close(): void };

class ToolKvResourceService extends Context.Service<
  ToolKvResourceService,
  {
    readonly open: (
      path: string,
      Database: DatabaseConstructor | undefined,
    ) => Effect.Effect<ManagedRigToolKvStore>;
  }
>()("@rendotdev/rig/persistence/ToolKvResourceService", {
  make: Effect.gen(function* () {
    const validateKey = (key: string) => {
      const isInvalidKey = typeof key !== "string" || key.length === 0;
      if (isInvalidKey) {
        throw new RigError({
          code: "INPUT_ERROR",
          message: "context.kv keys must be non-empty strings.",
          details: { key },
        });
      }
    };
    const create = (database: Database, path: string): ManagedRigToolKvStore => {
      const get = <Value = unknown>(key: string) => {
        validateKey(key);
        const row = database
          .query("select value_json from _rig_kv where key = ?")
          .get(key) as KvRow | null;
        return row ? (JSON.parse(row.value_json) as Value) : undefined;
      };
      const set = (key: string, value: unknown) => {
        validateKey(key);
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
          throw new RigError({
            code: "INPUT_ERROR",
            message: "context.kv cannot store undefined.",
          });
        }
        database
          .query(
            `insert into _rig_kv (key, value_json, updated_at)
             values ($key, $valueJson, $updatedAt)
             on conflict(key) do update set value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
          )
          .run({ key, valueJson, updatedAt: new Date().toISOString() });
      };
      const close = () => database.close(false);
      return { path, get, set, close } as const;
    };
    const unavailable = (path: string): ManagedRigToolKvStore => {
      const fail = (): never => {
        throw new RigError({
          code: "TOOL_INVALID",
          message: "context.kv requires the Bun SQLite runtime.",
          details: { path },
        });
      };
      return { path, get: fail, set: fail, close: () => undefined };
    };
    const openResource = (path: string, Database: DatabaseConstructor) => {
      mkdirSync(dirname(path), { recursive: true });
      const database = new Database(path, { create: true, strict: true });
      try {
        database.run("PRAGMA journal_mode = WAL;");
        database.run(`create table if not exists _rig_kv (
          key text primary key, value_json text not null, updated_at text not null
        );`);
        return create(database, path);
      } catch (error) {
        database.close(false);
        throw error;
      }
    };
    const open = Effect.fn("ToolKvResourceService.open")(function* (
      path: string,
      Database: DatabaseConstructor | undefined,
    ) {
      if (!Database) return unavailable(path);
      let store: ManagedRigToolKvStore | undefined;
      const resource = () => (store ??= openResource(path, Database));
      return {
        path,
        get: <Value = unknown>(key: string) => resource().get<Value>(key),
        set: (key: string, value: unknown) => resource().set(key, value),
        close: () => store?.close(),
      };
    });
    return { open } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolKvResourceService, ToolKvResourceService.make);
}

export class ToolKvService extends Context.Service<
  ToolKvService,
  {
    readonly pathForToolPath: (toolPath: string) => Effect.Effect<string>;
    readonly acquire: (
      tool: LoadedTool,
    ) => Effect.Effect<ManagedRigToolKvStore, RigError, Scope.Scope>;
  }
>()("@rendotdev/rig/persistence/ToolKvService", {
  make: Effect.gen(function* () {
    const databases = yield* SqlitePlatformService;
    const resources = yield* ToolKvResourceService;
    const pathForToolPath = Effect.fn("ToolKvService.pathForToolPath")(function* (
      toolPath: string,
    ) {
      return join(dirname(toolPath), "kv.sqlite");
    });
    const acquire = Effect.fn("ToolKvService.acquire")(function* (tool: LoadedTool) {
      const path = yield* pathForToolPath(tool.path);
      const Database = (yield* databases.available) ? yield* databases.load : undefined;
      return yield* Effect.acquireRelease(resources.open(path, Database), (resource) =>
        Effect.sync(resource.close),
      );
    });
    return { pathForToolPath, acquire } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolKvService, ToolKvService.make);
}

export const toolKvLayer = ToolKvService.layer.pipe(
  Layer.provide(Layer.merge(SqlitePlatformService.layer, ToolKvResourceService.layer)),
);
