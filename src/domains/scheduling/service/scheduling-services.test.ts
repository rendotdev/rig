import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { RigError } from "../../../providers/errors/rig-error";
import { RigConfigStoreService } from "../../settings/service/config-store";
import { RigConfigError } from "../../settings/types/config-error";
import type { RigConfig, RigCronJob } from "../../settings/types/config-schema";
import { CronRegistrarService } from "../repo/cron-registrar";
import { CronWorkerRepositoryService } from "../repo/cron-worker-repository";
import { CronStateError } from "../types/cron";
import {
  CronRemoveTransactionService,
  CronReplaceTransactionService,
  CronRollbackService,
  CronStateTransactionService,
} from "./cron-state-transaction";
import { CronModelService, cronModelLayer } from "./cron-model";

type TestState = {
  config: RigConfig;
  workers: Map<string, string>;
  registerCalls: Array<{ path: string; schedule: string; title: string }>;
  removeCalls: string[];
  failRegister: unknown[];
  failRemove: unknown[];
  failWorkerRemove?: unknown;
  failConfigUpdates: number[];
  updateCalls: number;
};

const emptyConfig: RigConfig = {
  version: 1,
  baseRegistryDir: "~/rig/tools",
  customRegistries: [],
  cronJobs: [],
};

const createState = (jobs: RigCronJob[] = []): TestState => ({
  config: { ...emptyConfig, cronJobs: jobs },
  workers: new Map(),
  registerCalls: [],
  removeCalls: [],
  failRegister: [],
  failRemove: [],
  failConfigUpdates: [],
  updateCalls: 0,
});

const testError = (cause: unknown) =>
  new RigError({ code: "CRON_ERROR", message: String(cause), details: cause });

const configLayer = (state: TestState) =>
  Layer.succeed(RigConfigStoreService, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    migrationResult: Effect.succeed(undefined),
    acknowledgeMigrationPrompt: Effect.void,
    ensure: Effect.sync(() => state.config),
    read: Effect.sync(() => state.config),
    write: (config) => Effect.sync(() => void (state.config = config)),
    update: (mutator) =>
      Effect.gen(function* () {
        state.updateCalls += 1;
        const next = yield* Effect.tryPromise({
          try: () => Promise.resolve(mutator(state.config)),
          catch: (cause) => new RigConfigError({ operation: "update", cause }),
        });
        if (state.failConfigUpdates.includes(state.updateCalls)) {
          return yield* new RigConfigError({
            operation: "update",
            cause: new Error("config unavailable"),
          });
        }
        state.config = next;
        return next;
      }),
  });

const registrarLayer = (state: TestState) =>
  Layer.succeed(CronRegistrarService, {
    register: (params) =>
      Effect.suspend(() => {
        state.registerCalls.push(params);
        const failure = state.failRegister.shift();
        return failure === undefined ? Effect.void : Effect.fail(testError(failure));
      }),
    remove: (title) =>
      Effect.suspend(() => {
        state.removeCalls.push(title);
        const failure = state.failRemove.shift();
        return failure === undefined ? Effect.void : Effect.fail(testError(failure));
      }),
    validate: () => Effect.void,
  });

const workerRepositoryLayer = (state: TestState) =>
  Layer.succeed(CronWorkerRepositoryService, {
    read: (path) => Effect.succeed(state.workers.get(path)),
    write: (path, source) =>
      Effect.sync(() => {
        state.workers.set(path, source);
      }),
    remove: (path) =>
      Effect.suspend(() => {
        if (state.failWorkerRemove !== undefined) {
          return Effect.fail(new CronStateError({ cause: state.failWorkerRemove }));
        }
        state.workers.delete(path);
        return Effect.void;
      }),
  });

const transactionLayer = (state: TestState) => {
  const dependencies = Layer.mergeAll(
    configLayer(state),
    registrarLayer(state),
    workerRepositoryLayer(state),
  );
  const rollback = CronRollbackService.layer.pipe(Layer.provide(dependencies));
  const replace = CronReplaceTransactionService.layer.pipe(
    Layer.provide(Layer.merge(dependencies, rollback)),
  );
  const remove = CronRemoveTransactionService.layer.pipe(
    Layer.provide(Layer.merge(dependencies, rollback)),
  );
  return CronStateTransactionService.layer.pipe(
    Layer.provide(Layer.mergeAll(workerRepositoryLayer(state), rollback, replace, remove)),
  );
};

const runTransaction = <Value>(
  state: TestState,
  operation: (
    service: CronStateTransactionService["Service"],
  ) => Effect.Effect<Value, CronStateError>,
) =>
  Effect.runPromise(
    CronStateTransactionService.use(operation).pipe(Effect.provide(transactionLayer(state))),
  );

describe("cron model", () => {
  test("validates identifiers, parses input, and renders workers", async () => {
    const result = await Effect.runPromise(
      CronModelService.use((model) =>
        Effect.gen(function* () {
          const target = yield* model.parseCommandTarget("sample.example");
          const input = yield* model.readInput({ input: '{"text":"hello"}' });
          const worker = yield* model.renderWorker({
            name: "weekly",
            moduleUrl: new URL("../cli.ts", import.meta.url).href,
          });
          return { target, input, worker };
        }),
      ).pipe(Effect.provide(cronModelLayer)),
    );

    expect(result.target).toEqual({ id: "sample.example", tool: "sample", command: "example" });
    expect(result.input).toEqual({ text: "hello" });
    expect(result.worker).toContain('"cron"');
    expect(result.worker).toContain('"weekly"');
  });

  test("rejects invalid names, targets, and conflicting input sources", async () => {
    const effects = await Effect.runPromise(
      CronModelService.use((model) =>
        Effect.succeed([
          model.parseJobName("bad name"),
          model.parseCommandTarget("missing-separator"),
          model.readInput({ input: "{}", inputFile: "input.json" }),
        ] as const),
      ).pipe(Effect.provide(cronModelLayer)),
    );

    await expect(Effect.runPromise(effects[0])).rejects.toThrow("Cron job names may only contain");
    await expect(Effect.runPromise(effects[1])).rejects.toThrow("Command id must use");
    await expect(Effect.runPromise(effects[2])).rejects.toThrow("Use --input or --input-file");
  });
});

describe("cron state transactions", () => {
  test("restores config and worker state when registration fails", async () => {
    const state = createState();
    state.workers.set("/cron/weekly.ts", "previous worker");
    state.failRegister.push(new Error("launchd unavailable"));

    await expect(
      runTransaction(state, (transaction) =>
        transaction.replace({
          snapshot: { workerSource: "previous worker" },
          workerPath: "/cron/weekly.ts",
          workerSource: "replacement worker",
          job: { name: "weekly", command: "sample.example", schedule: "@weekly" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CronStateError" });

    expect(state.config.cronJobs).toEqual([]);
    expect(state.workers.get("/cron/weekly.ts")).toBe("previous worker");
    expect(state.removeCalls).toEqual(["weekly"]);
  });

  test("restores a removed job, worker, and registration after a local failure", async () => {
    const job = { name: "weekly", command: "sample.example", schedule: "@weekly" };
    const state = createState([job]);
    state.workers.set("/cron/weekly.ts", "worker");
    state.failWorkerRemove = new Error("disk unavailable");

    await expect(
      runTransaction(state, (transaction) =>
        transaction.remove({
          snapshot: { workerSource: "worker" },
          workerPath: "/cron/weekly.ts",
          name: "weekly",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CronStateError" });

    expect(state.config.cronJobs).toEqual([job]);
    expect(state.workers.get("/cron/weekly.ts")).toBe("worker");
    expect(state.registerCalls).toEqual([
      { path: "/cron/weekly.ts", schedule: "@weekly", title: "weekly" },
    ]);
  });

  test("restores registration when config removal fails after unregistering", async () => {
    const job = { name: "weekly", command: "sample.example", schedule: "@weekly" };
    const state = createState([job]);
    state.workers.set("/cron/weekly.ts", "worker");
    state.failConfigUpdates.push(1);

    await expect(
      runTransaction(state, (transaction) =>
        transaction.remove({
          snapshot: { workerSource: "worker" },
          workerPath: "/cron/weekly.ts",
          name: "weekly",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CronStateError" });

    expect(state.config.cronJobs).toEqual([job]);
    expect(state.workers.get("/cron/weekly.ts")).toBe("worker");
    expect(state.removeCalls).toEqual(["weekly"]);
    expect(state.registerCalls).toEqual([
      { path: "/cron/weekly.ts", schedule: "@weekly", title: "weekly" },
    ]);
  });

  test("reports rollback failures without hiding the original failure", async () => {
    const previous = { name: "weekly", command: "sample.example", schedule: "@weekly" };
    const state = createState([previous]);
    state.workers.set("/cron/weekly.ts", "previous worker");
    state.failRegister.push(new Error("replacement unavailable"), new Error("restore unavailable"));

    await expect(
      runTransaction(state, (transaction) =>
        transaction.replace({
          snapshot: { workerSource: "previous worker" },
          workerPath: "/cron/weekly.ts",
          workerSource: "replacement worker",
          job: { ...previous, schedule: "@daily" },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "CronStateError",
      rollbackErrors: [expect.objectContaining({ message: "Error: restore unavailable" })],
    });
    expect(state.config.cronJobs).toEqual([previous]);
    expect(state.workers.get("/cron/weekly.ts")).toBe("previous worker");
  });

  test("keeps newer config state during optimistic rollback", async () => {
    const newer = { name: "weekly", command: "sample.example", schedule: "@daily" };
    const failed = { ...newer, schedule: "@weekly" };
    const state = createState([newer]);

    await runTransaction(state, (transaction) =>
      transaction.restoreReplacedJob(failed, { ...failed, schedule: "@monthly" }),
    );

    expect(state.config.cronJobs).toEqual([newer]);
  });

  test("returns empty snapshots and false removals for missing jobs", async () => {
    const state = createState();
    expect(
      await runTransaction(state, (transaction) => transaction.snapshot("/cron/missing.ts")),
    ).toEqual({});
    expect(
      await runTransaction(state, (transaction) =>
        transaction.remove({ snapshot: {}, workerPath: "/cron/missing.ts", name: "missing" }),
      ),
    ).toBe(false);
  });
});
