import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { ToolCacheService, toolCacheLayer } from "../../src/domains/tools/repo/tool-cache";
import { ToolDatabaseService, toolDatabaseLayer } from "../../src/domains/tools/repo/tool-database";
import { ToolKvService, toolKvLayer } from "../../src/domains/tools/repo/tool-kv";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
  type PathOptions,
} from "../../src/providers/paths/rig-paths";
import { ToolFilesService } from "../../src/domains/tools/runtime/tool-files";
import { ToolHelpService } from "../../src/domains/tools/runtime/tool-help";
import { ToolInspectorService } from "../../src/domains/tools/runtime/tool-inspector";
import { ToolListService, type ToolListData } from "../../src/domains/tools/runtime/tool-list";
import { RuntimeSupportService } from "../../src/domains/tools/runtime/runtime-support";
import {
  RunInputService,
  ToolRunnerService,
  runInputLayer,
} from "../../src/domains/tools/runtime/tool-runner";
import { toolInputParserLayer } from "../../src/domains/tools/service/tool-input-parser";
import type {
  CommandDefinition,
  LoadedTool,
  RigToolLogger,
} from "../../src/domains/tools/types/tool-types";
import type {
  RunCommandOptions,
  RunCommandResult,
} from "../../src/domains/tools/types/tool-runner";
import { ToolTypecheckService } from "../../src/domains/tools/runtime/tool-typecheck";
import { toolServicesLayer } from "../../src/domains/tools/runtime/tool-services-layer";

type ToolRunnerClient = {
  run: (tool: string, command: string, options?: RunCommandOptions) => Promise<RunCommandResult>;
  dispose: () => Promise<void>;
};

const serviceLayer = (homeDir?: string) =>
  toolServicesLayer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(RigPathsOptionsConfigService, { homeDir }),
        RigPathsPlatformService.layer,
      ),
    ),
  );

const runToolService = <A, E>(
  homeDir: string | undefined,
  effect: Effect.Effect<
    A,
    E,
    | ToolFilesService
    | ToolHelpService
    | ToolInspectorService
    | ToolListService
    | RuntimeSupportService
    | ToolRunnerService
    | ToolTypecheckService
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(serviceLayer(homeDir))));

export const createTool = (options: PathOptions, name: string) =>
  runToolService(
    options.homeDir,
    ToolFilesService.use((service) => service.create(name)),
  );

export const renderToolHelp = (options: PathOptions, toolName: string, commandName?: string) =>
  runToolService(
    options.homeDir,
    ToolHelpService.use((service) => service.render(toolName, commandName)),
  );

export const inspectTool = (options: PathOptions, toolName: string, commandName?: string) =>
  runToolService(
    options.homeDir,
    ToolInspectorService.use((service) => service.inspect(toolName, commandName)),
  );

export const typecheckTools = (options: PathOptions, toolName?: string) =>
  runToolService(
    options.homeDir,
    Effect.gen(function* () {
      yield* RuntimeSupportService.use((service) => service.ensure());
      return yield* ToolTypecheckService.use((service) => service.typecheck(toolName));
    }),
  );

export const makeToolListClient = (options: PathOptions) => ({
  list: () =>
    runToolService(
      options.homeDir,
      ToolListService.use((service) => service.list()),
    ),
  renderPlain: (data: ToolListData) =>
    runToolService(
      options.homeDir,
      ToolListService.use((service) => service.renderPlain(data)),
    ),
});

export const readRunInput = (command: CommandDefinition, options: RunCommandOptions) =>
  Effect.runPromise(
    RunInputService.use((service) => service.read(command, options)).pipe(
      Effect.provide(runInputLayer.pipe(Layer.provide(toolInputParserLayer))),
    ),
  );

const resourceScopes: Scope.Scope[] = [];
const acquireResource = async <A, E, R>(
  layer: Layer.Layer<R>,
  effect: Effect.Effect<A, E, R | Scope.Scope>,
): Promise<A> => {
  const scope = await Effect.runPromise(Scope.make());
  resourceScopes.push(scope);
  try {
    return await Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provideService(Scope.Scope, scope)),
    );
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
};

export const databasePathForToolPath = (toolPath: string) =>
  Effect.runSync(
    ToolDatabaseService.use((service) => service.pathForToolPath(toolPath)).pipe(
      Effect.provide(toolDatabaseLayer),
    ),
  );
export const setupToolDatabase = (tool: LoadedTool) =>
  acquireResource(
    toolDatabaseLayer,
    ToolDatabaseService.use((service) => service.acquire(tool)),
  );
export const kvPathForToolPath = (toolPath: string) =>
  Effect.runSync(
    ToolKvService.use((service) => service.pathForToolPath(toolPath)).pipe(
      Effect.provide(toolKvLayer),
    ),
  );
export const setupToolKvStore = (tool: LoadedTool) =>
  acquireResource(
    toolKvLayer,
    ToolKvService.use((service) => service.acquire(tool)),
  );
export const cachePathForToolPath = (toolPath: string) =>
  Effect.runSync(
    ToolCacheService.use((service) => service.pathForToolPath(toolPath)).pipe(
      Effect.provide(toolCacheLayer),
    ),
  );
export const setupToolCache = (tool: LoadedTool, log: RigToolLogger) =>
  acquireResource(
    toolCacheLayer,
    ToolCacheService.use((service) => service.acquire(tool, log)),
  );

const testHomes: string[] = [];

export const homes = {
  create: async (): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), "rig-test-home-"));
    testHomes.push(home);
    return home;
  },
  cleanup: async (): Promise<void> => {
    new FakeSqliteEnvironment().uninstall();
    await Promise.all(
      testHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  },
} as const;

class FakeSqliteStore {
  readonly kv = new Map<string, string>();
  readonly cache = new Map<
    string,
    {
      keyJson: string;
      valueJson: string;
      dataUpdatedAt: number;
      invalidatedAt: number | null;
      lastAccessedAt: number;
    }
  >();
  readonly migrations = new Map<number, { name: string; checksum: string }>();
  readonly notes: string[] = [];
  setupRuns = 0;
  closeRuns = 0;
}

class FakeSqliteStatement {
  constructor(
    private readonly store: FakeSqliteStore,
    private readonly sql: string,
  ) {}

  get(params?: unknown): unknown {
    if (this.sql.includes("from _rig_migrations")) {
      return this.store.migrations.get(Number(params)) ?? null;
    }
    if (this.sql.includes("from _rig_kv")) {
      const valueJson = this.store.kv.get(String(params));
      return valueJson === undefined ? null : { value_json: valueJson };
    }
    if (this.sql.includes("from _rig_cache")) {
      const row = this.store.cache.get(String(params));
      if (!row) return null;
      return {
        key_json: row.keyJson,
        value_json: row.valueJson,
        data_updated_at: row.dataUpdatedAt,
        invalidated_at: row.invalidatedAt,
      };
    }
    if (this.sql.includes("count(*) as count from setup_runs")) {
      return { count: this.store.setupRuns };
    }
    return null;
  }

  run(params?: unknown): { lastInsertRowid: number; changes: number } {
    const record = this.recordParams(params);
    if (this.sql.includes("into _rig_migrations")) {
      this.store.migrations.set(Number(record.version), {
        name: String(record.name),
        checksum: String(record.checksum),
      });
      return { lastInsertRowid: Number(record.version), changes: 1 };
    }
    if (this.sql.includes("into setup_runs")) {
      this.store.setupRuns++;
      return { lastInsertRowid: this.store.setupRuns, changes: 1 };
    }
    if (this.sql.includes("into _rig_kv")) {
      this.store.kv.set(String(record.key), String(record.valueJson));
      return { lastInsertRowid: this.store.kv.size, changes: 1 };
    }
    if (this.sql.includes("into _rig_cache")) {
      this.store.cache.set(String(record.keyHash), {
        keyJson: String(record.keyJson),
        valueJson: String(record.valueJson),
        dataUpdatedAt: Number(record.dataUpdatedAt),
        invalidatedAt: null,
        lastAccessedAt: Number(record.lastAccessedAt),
      });
      return { lastInsertRowid: this.store.cache.size, changes: 1 };
    }
    if (this.sql.includes("set invalidated_at")) {
      const row = this.store.cache.get(String(record.keyHash));
      if (row) row.invalidatedAt = Number(record.invalidatedAt);
      return { lastInsertRowid: 0, changes: row ? 1 : 0 };
    }
    if (this.sql.includes("set last_accessed_at")) {
      const row = this.store.cache.get(String(record.keyHash));
      if (row) row.lastAccessedAt = Number(record.lastAccessedAt);
      return { lastInsertRowid: 0, changes: row ? 1 : 0 };
    }
    if (this.sql.includes("delete from _rig_cache where")) {
      const deleted = this.store.cache.delete(String(params));
      return { lastInsertRowid: 0, changes: deleted ? 1 : 0 };
    }
    if (this.sql.includes("into notes")) {
      this.store.notes.push(String(record.text));
      return { lastInsertRowid: this.store.notes.length, changes: 1 };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  private recordParams(params: unknown): Record<string, unknown> {
    return typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  }
}

export class FakeSqliteDatabase {
  private static readonly stores = new Map<string, FakeSqliteStore>();
  private static failNextRunPattern?: string;
  private readonly store: FakeSqliteStore;

  constructor(filename: string) {
    if (!existsSync(filename)) writeFileSync(filename, "");
    const existing = FakeSqliteDatabase.stores.get(filename);
    this.store = existing ?? new FakeSqliteStore();
    FakeSqliteDatabase.stores.set(filename, this.store);
  }

  static reset(): void {
    this.stores.clear();
    this.failNextRunPattern = undefined;
  }

  static failNextRunContaining(pattern: string): void {
    this.failNextRunPattern = pattern;
  }

  static store(filename: string): FakeSqliteStore | undefined {
    return this.stores.get(filename);
  }

  query(sql: string): FakeSqliteStatement {
    return new FakeSqliteStatement(this.store, sql);
  }

  run(sql: string): { lastInsertRowid: number; changes: number } {
    const shouldFailInitialization =
      FakeSqliteDatabase.failNextRunPattern && sql.includes(FakeSqliteDatabase.failNextRunPattern);
    if (shouldFailInitialization) {
      FakeSqliteDatabase.failNextRunPattern = undefined;
      throw new Error("sqlite initialization failed");
    }
    if (sql.includes("delete from _rig_cache")) {
      const changes = this.store.cache.size;
      this.store.cache.clear();
      return { lastInsertRowid: 0, changes };
    }
    return { lastInsertRowid: 0, changes: 0 };
  }

  transaction<T>(callback: () => T): () => T {
    return () => callback();
  }

  close(): void {
    this.store.closeRuns++;
  }
}

export class FakeSqliteEnvironment {
  install(): void {
    (
      globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: unknown }
    ).rigSqliteDatabaseForTests = FakeSqliteDatabase;
  }

  uninstall(): void {
    delete (globalThis as typeof globalThis & { rigSqliteDatabaseForTests?: unknown })
      .rigSqliteDatabaseForTests;
    FakeSqliteDatabase.reset();
  }

  failNextInitialization(): void {
    FakeSqliteDatabase.failNextRunContaining("PRAGMA journal_mode = WAL");
  }
}

const toolRunners: ToolRunnerClient[] = [];

export function createToolRunner(options: { homeDir?: string }): ToolRunnerClient {
  const client: ToolRunnerClient = {
    run: (tool, command, runOptions = {}) =>
      runToolService(
        options.homeDir,
        ToolRunnerService.use((service) => service.run(tool, command, runOptions)),
      ),
    dispose: () => Promise.resolve(),
  };
  toolRunners.push(client);
  return client;
}

export const cleanupToolRunnerTests = async () => {
  await Promise.all(toolRunners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(
    resourceScopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  await homes.cleanup();
};

export class DbSetupTestToolWriter {
  constructor(private readonly home: string) {}

  async write(name: string, setup: string): Promise<string> {
    const toolDir = join(this.home, "rig", "tools", name);
    await mkdir(toolDir, { recursive: true });
    const toolPath = join(toolDir, "index.rig.ts");
    await writeFile(toolPath, this.source(name, setup), "utf8");
    return toolPath;
  }

  private source(name: string, setup: string): string {
    return `export default (rig) => rig.defineTool({
  name: ${JSON.stringify(name)},
  description: "DB error test tool.",
  setupDb: (db) => { ${setup} },
  commands: {
    check: rig.defineCommand({
      description: "Check DB setup.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`;
  }
}
