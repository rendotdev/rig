import { Context, Effect, Layer, Result } from "effect";
import type { RigCronJob } from "../../settings/types/config-schema";
import { RigConfigStoreService } from "../../settings/service/config-store";
import { CronRegistrarService, cronRegistrarLayer } from "../repo/cron-registrar";
import {
  CronWorkerRepositoryService,
  cronWorkerRepositoryLayer,
} from "../repo/cron-worker-repository";
import { CronStateError, type CronWorkerSnapshot } from "../types/cron";

export class CronRollbackService extends Context.Service<
  CronRollbackService,
  {
    readonly restoreReplacedJob: (
      job: RigCronJob,
      previousJob?: RigCronJob,
    ) => Effect.Effect<void, CronStateError>;
    readonly restoreRemovedJob: (previousJob: RigCronJob) => Effect.Effect<void, CronStateError>;
    readonly restoreWorker: (
      snapshot: CronWorkerSnapshot,
      workerPath: string,
    ) => Effect.Effect<void, CronStateError>;
  }
>()("@rendotdev/rig/cron/CronRollbackService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const workers = yield* CronWorkerRepositoryService;
    const sameJob = (left: RigCronJob, right: RigCronJob) =>
      JSON.stringify(left) === JSON.stringify(right);
    const restoreReplacedJob = Effect.fn("CronRollbackService.restoreReplacedJob")(function* (
      job: RigCronJob,
      previousJob?: RigCronJob,
    ) {
      yield* config
        .update((current) => {
          const stored = current.cronJobs.find((candidate) => candidate.name === job.name);
          const shouldPreserveCurrentJob = !stored || !sameJob(stored, job);
          if (shouldPreserveCurrentJob) return current;
          const remaining = current.cronJobs.filter((candidate) => candidate.name !== job.name);
          return {
            ...current,
            cronJobs: previousJob ? [...remaining, previousJob] : remaining,
          };
        })
        .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
    });
    const restoreRemovedJob = Effect.fn("CronRollbackService.restoreRemovedJob")(function* (
      previousJob: RigCronJob,
    ) {
      yield* config
        .update((current) =>
          current.cronJobs.some((job) => job.name === previousJob.name)
            ? current
            : { ...current, cronJobs: [...current.cronJobs, previousJob] },
        )
        .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
    });
    const restoreWorker = Effect.fn("CronRollbackService.restoreWorker")(function* (
      snapshot: CronWorkerSnapshot,
      workerPath: string,
    ) {
      if (snapshot.workerSource === undefined) yield* workers.remove(workerPath);
      else yield* workers.write(workerPath, snapshot.workerSource);
    });
    return { restoreReplacedJob, restoreRemovedJob, restoreWorker } as const;
  }),
}) {
  static readonly layer = Layer.effect(CronRollbackService, CronRollbackService.make);
}

export class CronReplaceTransactionService extends Context.Service<
  CronReplaceTransactionService,
  {
    readonly replace: (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly workerSource: string;
      readonly job: RigCronJob;
    }) => Effect.Effect<void, CronStateError>;
  }
>()("@rendotdev/rig/cron/CronReplaceTransactionService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const registrar = yield* CronRegistrarService;
    const workers = yield* CronWorkerRepositoryService;
    const rollback = yield* CronRollbackService;
    const capture = Effect.fn("CronReplaceTransactionService.capture")(function* (
      errors: unknown[],
      operation: Effect.Effect<void, CronStateError>,
    ) {
      const result = yield* Effect.result(operation);
      if (Result.isFailure(result)) errors.push(result.failure.cause);
    });
    const replace = Effect.fn("CronReplaceTransactionService.replace")(function* (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly workerSource: string;
      readonly job: RigCronJob;
    }) {
      let previousJob: RigCronJob | undefined;
      let workerChanged = false;
      let configChanged = false;
      let registrationAttempted = false;
      yield* Effect.gen(function* () {
        yield* workers.write(params.workerPath, params.workerSource);
        workerChanged = true;
        yield* config
          .update((current) => {
            previousJob = current.cronJobs.find((job) => job.name === params.job.name);
            return {
              ...current,
              cronJobs: [
                ...current.cronJobs.filter((job) => job.name !== params.job.name),
                params.job,
              ],
            };
          })
          .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
        configChanged = true;
        registrationAttempted = true;
        yield* registrar
          .register({
            path: params.workerPath,
            schedule: params.job.schedule,
            title: params.job.name,
          })
          .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const errors: unknown[] = [];
            if (configChanged)
              yield* capture(errors, rollback.restoreReplacedJob(params.job, previousJob));
            if (workerChanged)
              yield* capture(errors, rollback.restoreWorker(params.snapshot, params.workerPath));
            if (registrationAttempted) {
              const restoreRegistration = previousJob
                ? registrar.register({
                    path: params.workerPath,
                    schedule: previousJob.schedule,
                    title: previousJob.name,
                  })
                : registrar.remove(params.job.name);
              yield* capture(
                errors,
                restoreRegistration.pipe(
                  Effect.mapError((error) => new CronStateError({ cause: error })),
                ),
              );
            }
            return yield* new CronStateError({
              cause,
              ...(errors.length > 0 ? { rollbackErrors: errors } : {}),
            });
          }),
        ),
      );
    });
    return { replace } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CronReplaceTransactionService,
    CronReplaceTransactionService.make,
  );
}

export class CronRemoveTransactionService extends Context.Service<
  CronRemoveTransactionService,
  {
    readonly remove: (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly name: string;
    }) => Effect.Effect<boolean, CronStateError>;
  }
>()("@rendotdev/rig/cron/CronRemoveTransactionService", {
  make: Effect.gen(function* () {
    const config = yield* RigConfigStoreService;
    const registrar = yield* CronRegistrarService;
    const workers = yield* CronWorkerRepositoryService;
    const rollback = yield* CronRollbackService;
    const capture = Effect.fn("CronRemoveTransactionService.capture")(function* (
      errors: unknown[],
      operation: Effect.Effect<void, CronStateError>,
    ) {
      const result = yield* Effect.result(operation);
      if (Result.isFailure(result)) errors.push(result.failure.cause);
    });
    const remove = Effect.fn("CronRemoveTransactionService.remove")(function* (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly name: string;
    }) {
      const previousJob = (yield* config.read.pipe(
        Effect.mapError((cause) => new CronStateError({ cause })),
      )).cronJobs.find((job) => job.name === params.name);
      let configChanged = false;
      let registrationRemovalAttempted = false;
      let workerRemovalAttempted = false;
      return yield* Effect.gen(function* () {
        registrationRemovalAttempted = true;
        yield* registrar
          .remove(params.name)
          .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
        yield* config
          .update((current) => {
            return {
              ...current,
              cronJobs: current.cronJobs.filter((job) => job.name !== params.name),
            };
          })
          .pipe(Effect.mapError((cause) => new CronStateError({ cause })));
        configChanged = true;
        workerRemovalAttempted = true;
        yield* workers.remove(params.workerPath);
        return previousJob !== undefined;
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const errors: unknown[] = [];
            const shouldRestoreConfig = configChanged && previousJob !== undefined;
            if (shouldRestoreConfig)
              yield* capture(errors, rollback.restoreRemovedJob(previousJob));
            if (workerRemovalAttempted) {
              yield* capture(errors, rollback.restoreWorker(params.snapshot, params.workerPath));
            }
            const shouldRestoreRegistration =
              registrationRemovalAttempted && previousJob !== undefined;
            if (shouldRestoreRegistration) {
              yield* capture(
                errors,
                registrar
                  .register({
                    path: params.workerPath,
                    schedule: previousJob.schedule,
                    title: previousJob.name,
                  })
                  .pipe(Effect.mapError((error) => new CronStateError({ cause: error }))),
              );
            }
            return yield* new CronStateError({
              cause,
              ...(errors.length > 0 ? { rollbackErrors: errors } : {}),
            });
          }),
        ),
      );
    });
    return { remove } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CronRemoveTransactionService,
    CronRemoveTransactionService.make,
  );
}

export class CronStateTransactionService extends Context.Service<
  CronStateTransactionService,
  {
    readonly snapshot: (workerPath: string) => Effect.Effect<CronWorkerSnapshot, CronStateError>;
    readonly replace: (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly workerSource: string;
      readonly job: RigCronJob;
    }) => Effect.Effect<void, CronStateError>;
    readonly remove: (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly name: string;
    }) => Effect.Effect<boolean, CronStateError>;
    readonly restoreReplacedJob: (
      job: RigCronJob,
      previousJob?: RigCronJob,
    ) => Effect.Effect<void, CronStateError>;
    readonly restoreRemovedJob: (previousJob: RigCronJob) => Effect.Effect<void, CronStateError>;
  }
>()("@rendotdev/rig/cron/CronStateTransactionService", {
  make: Effect.gen(function* () {
    const workers = yield* CronWorkerRepositoryService;
    const replaceTransaction = yield* CronReplaceTransactionService;
    const removeTransaction = yield* CronRemoveTransactionService;
    const rollback = yield* CronRollbackService;
    const snapshot = Effect.fn("CronStateTransactionService.snapshot")(function* (
      workerPath: string,
    ) {
      const workerSource = yield* workers.read(workerPath);
      return workerSource === undefined ? {} : { workerSource };
    });
    const replace = Effect.fn("CronStateTransactionService.replace")(function* (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly workerSource: string;
      readonly job: RigCronJob;
    }) {
      yield* replaceTransaction.replace(params);
    });
    const remove = Effect.fn("CronStateTransactionService.remove")(function* (params: {
      readonly snapshot: CronWorkerSnapshot;
      readonly workerPath: string;
      readonly name: string;
    }) {
      return yield* removeTransaction.remove(params);
    });
    const restoreReplacedJob = Effect.fn("CronStateTransactionService.restoreReplacedJob")(
      function* (job: RigCronJob, previousJob?: RigCronJob) {
        yield* rollback.restoreReplacedJob(job, previousJob);
      },
    );
    const restoreRemovedJob = Effect.fn("CronStateTransactionService.restoreRemovedJob")(function* (
      previousJob: RigCronJob,
    ) {
      yield* rollback.restoreRemovedJob(previousJob);
    });
    return { snapshot, replace, remove, restoreReplacedJob, restoreRemovedJob } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CronStateTransactionService,
    CronStateTransactionService.make,
  );
}

const cronRollbackLayer = CronRollbackService.layer.pipe(Layer.provide(cronWorkerRepositoryLayer));

const cronReplaceTransactionLayer = CronReplaceTransactionService.layer.pipe(
  Layer.provide(Layer.mergeAll(cronWorkerRepositoryLayer, cronRollbackLayer, cronRegistrarLayer)),
);

const cronRemoveTransactionLayer = CronRemoveTransactionService.layer.pipe(
  Layer.provide(Layer.mergeAll(cronWorkerRepositoryLayer, cronRollbackLayer, cronRegistrarLayer)),
);

export const cronStateTransactionLayer = CronStateTransactionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      cronWorkerRepositoryLayer,
      cronRollbackLayer,
      cronReplaceTransactionLayer,
      cronRemoveTransactionLayer,
    ),
  ),
);
