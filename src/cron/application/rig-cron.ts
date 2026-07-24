import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineService, defineSingleton } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigConfigStoreClass } from "../../config/config";
import { RigPathsClass } from "../../config/paths";
import type { RigCronJob } from "../../config/schema";
import { RigErrorClass } from "../../errors/RigError";
import type { SuccessEnvelope } from "../../runtime/envelope";
import { commandTargets } from "../../tools/identifiers";
import { ToolRunnerClass } from "../../tools/run";

export type CronAddOptions = {
  name: string;
  command: string;
  schedule: string;
  input?: string;
  inputFile?: string;
  moduleUrl: string;
};

export type CronRunResult = {
  job: RigCronJob;
  envelope: unknown;
  exitCode: number;
};

type CronControllerLike = {
  cron?: string;
  scheduledTime?: number;
  type?: string;
};

type BunCronApi = {
  (path: string, schedule: string, title: string): Promise<void>;
  parse(expression: string): Date | null;
  remove(title: string): Promise<void>;
};

export type CronRegistrar = {
  register(params: { path: string; schedule: string; title: string }): Promise<void>;
  remove(params: { title: string }): Promise<void>;
  validate(params: { schedule: string }): void;
};

export type RigCronServiceParams = ConfigOptions;

export type RigCronServiceDeps = {
  registrar?: CronRegistrar;
};

export type RigCronWorkerParams = ConfigOptions;

export type RigCronWorkerDeps = {
  service?: RigCronServiceClass;
};

function getBunCron(_params: {}): BunCronApi {
  const cron = (globalThis as typeof globalThis & { Bun?: { cron?: unknown } }).Bun?.cron;
  /* v8 ignore next 3 */
  if (typeof cron !== "function") {
    throw new RigErrorClass("CRON_ERROR", "Bun cron is unavailable. Run rig with Bun.");
  }
  return cron as BunCronApi;
}

export class BunCronRegistrarService extends defineService({
  params: {},
  deps: { getCron: getBunCron },
}) {
  public register(params: { path: string; schedule: string; title: string }): Promise<void> {
    return this.deps.getCron({})(params.path, params.schedule, params.title);
  }

  public remove(params: { title: string }): Promise<void> {
    return this.deps.getCron({}).remove(params.title);
  }

  public validate(params: { schedule: string }): void {
    const next = this.deps.getCron({}).parse(params.schedule);
    if (!next) {
      throw new RigErrorClass("CRON_ERROR", `Cron schedule has no future runs: ${params.schedule}`);
    }
  }
}

export const BunCronRegistrar = new BunCronRegistrarService();

function parseCronJobName(params: { value: string }): { value: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(params.value)) {
    throw new RigErrorClass(
      "INPUT_ERROR",
      "Cron job names may only contain letters, numbers, hyphens, and underscores.",
      { name: params.value },
    );
  }
  return { value: params.value };
}

export const CronJobNameSingleton = defineSingleton({
  params: {},
  deps: {},
  parse: parseCronJobName,
});

async function readJsonFile(params: { path: string }): Promise<unknown> {
  /* v8 ignore next 3 */
  return typeof Bun !== "undefined"
    ? Bun.file(params.path).json()
    : JSON.parse(await readFile(params.path, "utf8"));
}

export class CronInputReaderService extends defineService({
  params: {},
  deps: { readJsonFile },
}) {
  public async read(params: { input?: string; inputFile?: string }): Promise<unknown | undefined> {
    if (params.input && params.inputFile) {
      throw new RigErrorClass("INPUT_ERROR", "Use --input or --input-file, not both.");
    }
    if (params.inputFile) return await this.deps.readJsonFile({ path: params.inputFile });
    return params.input === undefined ? undefined : JSON.parse(params.input);
  }
}

export const CronInputReader = new CronInputReaderService();

function parseCronCommandTarget(params: { id: string }): {
  id: string;
  tool: string;
  command: string;
} {
  const target = commandTargets.parse(params.id);
  return { id: params.id, tool: target.tool, command: target.command };
}

export const CronCommandTargetSingleton = defineSingleton({
  params: {},
  deps: {},
  parse: parseCronCommandTarget,
});

export class CronWorkerScriptService extends defineService({
  params: {},
  deps: { fileUrlToPath: fileURLToPath },
}) {
  public render(params: { name: string; homeDir?: string; moduleUrl: string }): string {
    const entrypoint = this.deps.fileUrlToPath(params.moduleUrl);
    /* v8 ignore next */
    const env = params.homeDir ? { RIG_HOME: params.homeDir } : {};
    return `export default {
  async scheduled() {
    const proc = Bun.spawn([
      process.execPath,
      "--install=fallback",
      ${JSON.stringify(entrypoint)},
      "cron",
      "run",
      ${JSON.stringify(params.name)},
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...${JSON.stringify(env)} },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (stdout) console.log(stdout.trimEnd());
    if (stderr) console.error(stderr.trimEnd());
    if (exitCode !== 0) throw new Error("Rig cron job failed: " + ${JSON.stringify(params.name)});
  },
};
`;
  }
}

export const CronWorkerScript = new CronWorkerScriptService();

type CronWorkerSnapshot = {
  workerSource?: string;
};

type CronConfigStore = Pick<RigConfigStoreClass, "update">;

type CronStateTransactionDeps = {
  configStore: CronConfigStore;
  registrar: CronRegistrar;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  rm: typeof rm;
  dirname: typeof dirname;
};

const CronStateTransactionProductionDeps: CronStateTransactionDeps = {
  configStore: new RigConfigStoreClass({}),
  registrar: BunCronRegistrar,
  readFile,
  writeFile,
  mkdir,
  rm,
  dirname,
};

function sameJob(params: { left: RigCronJob; right: RigCronJob }): boolean {
  return JSON.stringify(params.left) === JSON.stringify(params.right);
}

function errorMessage(params: { error: unknown }): string {
  return params.error instanceof Error ? params.error.message : String(params.error);
}

function isMissingFile(params: { error: unknown }): boolean {
  return (
    typeof params.error === "object" &&
    params.error !== null &&
    "code" in params.error &&
    (params.error as { code?: unknown }).code === "ENOENT"
  );
}

async function captureRollbackError(params: {
  rollbackErrors: unknown[];
  rollback: () => Promise<void>;
}): Promise<void> {
  try {
    await params.rollback();
  } catch (error) {
    params.rollbackErrors.push(error);
  }
}

export class CronStateTransactionService extends defineService({
  params: {},
  deps: CronStateTransactionProductionDeps,
}) {
  private async writeWorker(params: { workerPath: string; source: string }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(params.workerPath), { recursive: true });
    await this.deps.writeFile(params.workerPath, params.source, "utf8");
  }

  private async readWorker(params: { workerPath: string }): Promise<string | undefined> {
    try {
      return await this.deps.readFile(params.workerPath, "utf8");
    } catch (error) {
      /* v8 ignore else -- non-ENOENT read failures are propagated unchanged */
      if (isMissingFile({ error })) return undefined;
      /* v8 ignore next */
      throw error;
    }
  }

  public async snapshot(params: { workerPath: string }): Promise<CronWorkerSnapshot> {
    return { workerSource: await this.readWorker(params) };
  }

  public async restoreReplacedJob(params: {
    job: RigCronJob;
    previousJob?: RigCronJob;
  }): Promise<void> {
    await this.deps.configStore.update(function restoreConfig(config) {
      const current = config.cronJobs.find((candidate) => candidate.name === params.job.name);
      if (!current || !sameJob({ left: current, right: params.job })) return config;
      const withoutReplacement = config.cronJobs.filter(
        (candidate) => candidate.name !== params.job.name,
      );
      return {
        ...config,
        cronJobs: params.previousJob
          ? [...withoutReplacement, params.previousJob]
          : withoutReplacement,
      };
    });
  }

  public async restoreRemovedJob(params: { previousJob: RigCronJob }): Promise<void> {
    await this.deps.configStore.update(function restoreConfig(config) {
      if (config.cronJobs.some((job) => job.name === params.previousJob.name)) return config;
      return { ...config, cronJobs: [...config.cronJobs, params.previousJob] };
    });
  }

  private async restoreWorker(params: {
    snapshot: CronWorkerSnapshot;
    workerPath: string;
  }): Promise<void> {
    if (params.snapshot.workerSource === undefined) {
      await this.deps.rm(params.workerPath, { force: true });
      return;
    }
    await this.writeWorker({
      workerPath: params.workerPath,
      source: params.snapshot.workerSource,
    });
  }

  private throwAfterRollback(params: { error: unknown; rollbackErrors: unknown[] }): never {
    if (params.rollbackErrors.length === 0) throw params.error;
    throw new RigErrorClass("CRON_ERROR", "Cron state rollback was incomplete.", {
      cause: errorMessage({ error: params.error }),
      rollbackErrors: params.rollbackErrors.map(function formatRollbackError(rollbackError) {
        return errorMessage({ error: rollbackError });
      }),
    });
  }

  public async replace(params: {
    snapshot: CronWorkerSnapshot;
    workerPath: string;
    workerSource: string;
    job: RigCronJob;
  }): Promise<void> {
    let previousJob: RigCronJob | undefined;
    let workerChanged = false;
    let configChanged = false;
    let registrationAttempted = false;
    try {
      await this.writeWorker({ workerPath: params.workerPath, source: params.workerSource });
      workerChanged = true;
      await this.deps.configStore.update(function replaceJob(config) {
        previousJob = config.cronJobs.find((existing) => existing.name === params.job.name);
        return {
          ...config,
          cronJobs: [
            ...config.cronJobs.filter((existing) => existing.name !== params.job.name),
            params.job,
          ],
        };
      });
      configChanged = true;
      registrationAttempted = true;
      await this.deps.registrar.register({
        path: params.workerPath,
        schedule: params.job.schedule,
        title: params.job.name,
      });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (configChanged) {
        await captureRollbackError({
          rollbackErrors,
          rollback: () => this.restoreReplacedJob({ job: params.job, previousJob }),
        });
      }
      if (workerChanged) {
        await captureRollbackError({
          rollbackErrors,
          rollback: () =>
            this.restoreWorker({
              snapshot: params.snapshot,
              workerPath: params.workerPath,
            }),
        });
      }
      if (registrationAttempted) {
        const registrationRollback = previousJob
          ? () =>
              this.deps.registrar.register({
                path: params.workerPath,
                schedule: previousJob!.schedule,
                title: previousJob!.name,
              })
          : () => this.deps.registrar.remove({ title: params.job.name });
        await captureRollbackError({ rollbackErrors, rollback: registrationRollback });
      }
      this.throwAfterRollback({ error, rollbackErrors });
    }
  }

  public async remove(params: {
    snapshot: CronWorkerSnapshot;
    workerPath: string;
    name: string;
  }): Promise<boolean> {
    let previousJob: RigCronJob | undefined;
    let configChanged = false;
    await this.deps.registrar.remove({ title: params.name });
    try {
      await this.deps.configStore.update(function removeJob(config) {
        previousJob = config.cronJobs.find((job) => job.name === params.name);
        return {
          ...config,
          cronJobs: config.cronJobs.filter((job) => job.name !== params.name),
        };
      });
      configChanged = true;
      await this.deps.rm(params.workerPath, { force: true });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (configChanged && previousJob) {
        await captureRollbackError({
          rollbackErrors,
          rollback: () => this.restoreRemovedJob({ previousJob: previousJob! }),
        });
      }
      await captureRollbackError({
        rollbackErrors,
        rollback: () =>
          this.restoreWorker({
            snapshot: params.snapshot,
            workerPath: params.workerPath,
          }),
      });
      if (previousJob) {
        await captureRollbackError({
          rollbackErrors,
          rollback: () =>
            this.deps.registrar.register({
              path: params.workerPath,
              schedule: previousJob!.schedule,
              title: previousJob!.name,
            }),
        });
      }
      this.throwAfterRollback({ error, rollbackErrors });
    }
    return previousJob !== undefined;
  }
}

type CronPaths = Pick<RigPathsClass, "cronWorkerPath">;
type CronServiceStore = Pick<RigConfigStoreClass, "ensure" | "update">;
type CronTransaction = CronStateTransactionService;
type LegacyCronTransaction = Omit<CronTransaction, "restoreReplacedJob" | "restoreRemovedJob"> & {
  restoreReplacedJob(job: RigCronJob, previousJob?: RigCronJob): Promise<void>;
  restoreRemovedJob(previousJob: RigCronJob): Promise<void>;
};

type RigCronServiceDefinitionDeps = {
  registrar: CronRegistrar;
  createPaths: (params: RigCronServiceParams) => CronPaths;
  createConfigStore: (params: RigCronServiceParams) => CronServiceStore;
  readInput: CronInputReaderService["read"];
  renderWorker: CronWorkerScriptService["render"];
  createTransaction: (params: {
    configStore: CronServiceStore;
    registrar: CronRegistrar;
  }) => CronTransaction;
  runTool: (params: {
    config: RigCronServiceParams;
    tool: string;
    command: string;
    options: RigCronServiceParams & { input?: string; dryRun?: boolean };
  }) => Promise<{ envelope: unknown; exitCode: number }>;
};

const RigCronServiceProductionDeps: RigCronServiceDefinitionDeps = {
  registrar: BunCronRegistrar,
  createPaths(params) {
    return new RigPathsClass(params);
  },
  createConfigStore(params) {
    return new RigConfigStoreClass(params);
  },
  readInput(params) {
    return CronInputReader.read(params);
  },
  renderWorker(params) {
    return CronWorkerScript.render(params);
  },
  createTransaction(params) {
    return new CronStateTransactionService({
      params: {},
      deps: {
        ...CronStateTransactionProductionDeps,
        configStore: params.configStore,
        registrar: params.registrar,
      },
    });
  },
  async runTool(params) {
    return await new ToolRunnerClass(params.config).run(
      params.tool,
      params.command,
      params.options,
    );
  },
};

export class RigCronService extends defineService({
  params: {} as RigCronServiceParams,
  deps: RigCronServiceProductionDeps,
}) {
  private readonly paths = this.deps.createPaths(this.params);
  private readonly configStore = this.deps.createConfigStore(this.params);
  private readonly transaction = this.deps.createTransaction({
    configStore: this.configStore,
    registrar: this.deps.registrar,
  });

  public async list(_params: {}): Promise<{ cronJobs: RigCronJob[] }> {
    const rigConfig = await this.configStore.ensure();
    return {
      cronJobs: [...rigConfig.cronJobs].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  }

  private async validateCommand(params: {
    target: { id: string; tool: string; command: string };
    input: unknown | undefined;
  }): Promise<void> {
    const result = await this.deps.runTool({
      config: this.params,
      tool: params.target.tool,
      command: params.target.command,
      options: {
        ...this.params,
        input: params.input === undefined ? undefined : JSON.stringify(params.input),
        dryRun: true,
      },
    });
    if (result.exitCode !== 0) {
      throw new RigErrorClass("CRON_ERROR", `Cron command validation failed: ${params.target.id}`, {
        envelope: result.envelope,
      });
    }
  }

  public async add(params: CronAddOptions): Promise<{ job: RigCronJob; workerPath: string }> {
    const name = CronJobNameSingleton.parse({ value: params.name });
    const target = CronCommandTargetSingleton.parse({ id: params.command });
    const input = await this.deps.readInput(params);

    this.deps.registrar.validate({ schedule: params.schedule });
    await this.validateCommand({ target, input });

    await this.configStore.ensure();
    const job: RigCronJob = {
      name: name.value,
      command: target.id,
      schedule: params.schedule,
      ...(input === undefined ? {} : { input }),
    };
    const workerPath = this.paths.cronWorkerPath(name.value);
    const workerSource = this.deps.renderWorker({
      name: name.value,
      homeDir: this.params.homeDir,
      moduleUrl: params.moduleUrl,
    });
    const snapshot = await this.transaction.snapshot({ workerPath });
    await this.transaction.replace({ snapshot, workerPath, workerSource, job });

    return { job, workerPath };
  }

  public async remove(params: {
    name: string;
  }): Promise<{ name: string; removed: boolean; workerPath: string }> {
    const name = CronJobNameSingleton.parse({ value: params.name });
    await this.configStore.ensure();
    const workerPath = this.paths.cronWorkerPath(name.value);
    const snapshot = await this.transaction.snapshot({ workerPath });
    const removed = await this.transaction.remove({ snapshot, workerPath, name: name.value });
    return { name: name.value, removed, workerPath };
  }

  public async run(params: { name: string }): Promise<CronRunResult> {
    const name = CronJobNameSingleton.parse({ value: params.name });
    const rigConfig = await this.configStore.ensure();
    const job = rigConfig.cronJobs.find((candidate) => candidate.name === name.value);
    if (!job) {
      throw new RigErrorClass("CRON_ERROR", `Cron job not found: ${name.value}`, { name });
    }

    const target = CronCommandTargetSingleton.parse({ id: job.command });
    const result = await this.deps.runTool({
      config: this.params,
      tool: target.tool,
      command: target.command,
      options: {
        ...this.params,
        input: job.input === undefined ? undefined : JSON.stringify(job.input),
      },
    });
    return { job, envelope: result.envelope, exitCode: result.exitCode };
  }
}

export type RigCronServiceClass = {
  list(): Promise<{ cronJobs: RigCronJob[] }>;
  add(params: CronAddOptions): Promise<{ job: RigCronJob; workerPath: string }>;
  remove(params: { name: string }): Promise<{ name: string; removed: boolean; workerPath: string }>;
  run(params: { name: string }): Promise<CronRunResult>;
};

type RigCronServiceConstructor = {
  new (params: RigCronServiceParams, deps: RigCronServiceDeps): RigCronServiceClass;
  readonly prototype: RigCronServiceClass;
};

type RigCronServiceAdapter = RigCronServiceClass & {
  readonly resource: RigCronService;
  readonly transaction: LegacyCronTransaction;
};

const RigCronServiceClassAdapter = function constructRigCronService(
  this: RigCronServiceAdapter,
  serviceParams: RigCronServiceParams,
  deps: RigCronServiceDeps,
): void {
  const registrar = deps.registrar ?? RigCronServiceProductionDeps.registrar;
  const resource = new RigCronService({
    params: serviceParams,
    deps: { ...RigCronServiceProductionDeps, registrar },
  });
  const transactionResource = RigCronServiceProductionDeps.createTransaction({
    configStore: RigCronServiceProductionDeps.createConfigStore(serviceParams),
    registrar,
  });
  const transaction: LegacyCronTransaction = {
    snapshot(params) {
      return transactionResource.snapshot(params);
    },
    replace(params) {
      return transactionResource.replace(params);
    },
    remove(params) {
      return transactionResource.remove(params);
    },
    restoreReplacedJob(job, previousJob) {
      return transactionResource.restoreReplacedJob({ job, previousJob });
    },
    restoreRemovedJob(previousJob) {
      return transactionResource.restoreRemovedJob({ previousJob });
    },
  };
  Object.defineProperties(this, {
    resource: { value: resource },
    transaction: { value: transaction },
  });
};
Object.defineProperty(RigCronServiceClassAdapter, "name", { value: "RigCronServiceClass" });
Object.defineProperties(RigCronServiceClassAdapter.prototype, {
  list: {
    configurable: true,
    value: function list(this: RigCronServiceAdapter) {
      return this.resource.list({});
    },
    writable: true,
  },
  add: {
    configurable: true,
    value: function add(this: RigCronServiceAdapter, params: CronAddOptions) {
      return this.resource.add(params);
    },
    writable: true,
  },
  remove: {
    configurable: true,
    value: function remove(this: RigCronServiceAdapter, params: { name: string }) {
      return this.resource.remove(params);
    },
    writable: true,
  },
  run: {
    configurable: true,
    value: function run(this: RigCronServiceAdapter, params: { name: string }) {
      return this.resource.run(params);
    },
    writable: true,
  },
});

export const RigCronServiceClass =
  RigCronServiceClassAdapter as unknown as RigCronServiceConstructor;

type RigCronWorkerServiceDeps = {
  runCron: (params: { config: RigCronWorkerParams; name: string }) => Promise<CronRunResult>;
  log: (message: string) => void;
  setExitCode: (code: number) => void;
};

const RigCronWorkerProductionDeps: RigCronWorkerServiceDeps = {
  async runCron(params) {
    return await new RigCronServiceClass(params.config, {}).run({ name: params.name });
  },
  log(message) {
    console.log(message);
  },
  setExitCode(code) {
    process.exitCode = code;
  },
};

export class RigCronWorkerService extends defineService({
  params: {} as RigCronWorkerParams,
  deps: RigCronWorkerProductionDeps,
}) {
  public async scheduled(params: { name: string; controller?: CronControllerLike }): Promise<void> {
    const result = await this.deps.runCron({ config: this.params, name: params.name });
    const envelope = result.envelope as Partial<SuccessEnvelope>;
    this.deps.log(
      JSON.stringify(
        {
          cron: {
            name: result.job.name,
            command: result.job.command,
            schedule: params.controller?.cron ?? result.job.schedule,
            scheduledTime: params.controller?.scheduledTime,
            type: params.controller?.type,
          },
          result: envelope,
        },
        null,
        2,
      ),
    );
    this.deps.setExitCode(result.exitCode);
  }
}

export type RigCronWorkerClass = {
  scheduled(params: { name: string; controller?: CronControllerLike }): Promise<void>;
};

type RigCronWorkerConstructor = {
  new (params: RigCronWorkerParams, deps: RigCronWorkerDeps): RigCronWorkerClass;
  readonly prototype: RigCronWorkerClass;
};

type RigCronWorkerAdapter = RigCronWorkerClass & {
  readonly resource: RigCronWorkerService;
};

const RigCronWorkerClassAdapter = function constructRigCronWorker(
  this: RigCronWorkerAdapter,
  params: RigCronWorkerParams,
  deps: RigCronWorkerDeps,
): void {
  const service = deps.service;
  Object.defineProperty(this, "resource", {
    value: new RigCronWorkerService({
      params,
      deps: service
        ? {
            ...RigCronWorkerProductionDeps,
            runCron(runParams) {
              return service.run({ name: runParams.name });
            },
          }
        : RigCronWorkerProductionDeps,
    }),
  });
};
Object.defineProperty(RigCronWorkerClassAdapter, "name", { value: "RigCronWorkerClass" });
Object.defineProperty(RigCronWorkerClassAdapter.prototype, "scheduled", {
  configurable: true,
  value: function scheduled(
    this: RigCronWorkerAdapter,
    params: { name: string; controller?: CronControllerLike },
  ) {
    return this.resource.scheduled(params);
  },
  writable: true,
});

export const RigCronWorkerClass = RigCronWorkerClassAdapter as unknown as RigCronWorkerConstructor;
export const RigCronWorker = RigCronWorkerClass;

export function cronModuleUrl(metaUrl: string): string {
  return pathToFileURL(fileURLToPath(metaUrl)).href;
}
