import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  register(path: string, schedule: string, title: string): Promise<void>;
  remove(title: string): Promise<void>;
  validate(schedule: string): void;
};

class BunCronRegistrarClass implements CronRegistrar {
  register(path: string, schedule: string, title: string): Promise<void> {
    return this.cron()(path, schedule, title);
  }

  remove(title: string): Promise<void> {
    return this.cron().remove(title);
  }

  validate(schedule: string): void {
    const next = this.cron().parse(schedule);
    if (!next)
      throw new RigErrorClass("CRON_ERROR", `Cron schedule has no future runs: ${schedule}`);
  }

  private cron(): BunCronApi {
    const cron = (globalThis as typeof globalThis & { Bun?: { cron?: unknown } }).Bun?.cron;
    /* v8 ignore next 3 */
    if (typeof cron !== "function") {
      throw new RigErrorClass("CRON_ERROR", "Bun cron is unavailable. Run rig with Bun.");
    }
    return cron as BunCronApi;
  }
}

class CronJobNameClass {
  constructor(readonly value: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new RigErrorClass(
        "INPUT_ERROR",
        "Cron job names may only contain letters, numbers, hyphens, and underscores.",
        { name: value },
      );
    }
  }
}

class CronInputReaderClass {
  async read(options: { input?: string; inputFile?: string }): Promise<unknown | undefined> {
    if (options.input && options.inputFile) {
      throw new RigErrorClass("INPUT_ERROR", "Use --input or --input-file, not both.");
    }

    if (options.inputFile) {
      /* v8 ignore next 3 */
      return typeof Bun !== "undefined"
        ? Bun.file(options.inputFile).json()
        : JSON.parse(await readFile(options.inputFile, "utf8"));
    }

    return options.input === undefined ? undefined : JSON.parse(options.input);
  }
}

class CronCommandTargetClass {
  readonly tool: string;
  readonly command: string;

  constructor(readonly id: string) {
    const target = commandTargets.parse(id);
    this.tool = target.tool;
    this.command = target.command;
  }
}

class CronWorkerScriptClass {
  render(params: { name: string; homeDir?: string; moduleUrl: string }): string {
    const entrypoint = fileURLToPath(params.moduleUrl);
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

type CronWorkerSnapshot = {
  workerSource?: string;
};

class CronStateTransactionClass {
  constructor(
    private readonly configStore: RigConfigStoreClass,
    private readonly registrar: CronRegistrar,
  ) {}

  async snapshot(workerPath: string): Promise<CronWorkerSnapshot> {
    return {
      workerSource: await this.readWorker(workerPath),
    };
  }

  async replace(params: {
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
      await this.writeWorker(params.workerPath, params.workerSource);
      workerChanged = true;
      await this.configStore.update((config) => {
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
      await this.registrar.register(params.workerPath, params.job.schedule, params.job.name);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (configChanged) {
        await this.captureRollbackError(rollbackErrors, () =>
          this.restoreReplacedJob(params.job, previousJob),
        );
      }
      if (workerChanged) {
        await this.captureRollbackError(rollbackErrors, () =>
          this.restoreWorker(params.snapshot, params.workerPath),
        );
      }
      if (registrationAttempted) {
        const registrationRollback = previousJob
          ? () =>
              this.registrar.register(params.workerPath, previousJob!.schedule, previousJob!.name)
          : () => this.registrar.remove(params.job.name);
        await this.captureRollbackError(rollbackErrors, registrationRollback);
      }
      this.throwAfterRollback(error, rollbackErrors);
    }
  }

  async remove(params: {
    snapshot: CronWorkerSnapshot;
    workerPath: string;
    name: string;
  }): Promise<boolean> {
    let previousJob: RigCronJob | undefined;
    let configChanged = false;
    await this.registrar.remove(params.name);
    try {
      await this.configStore.update((config) => {
        previousJob = config.cronJobs.find((job) => job.name === params.name);
        return {
          ...config,
          cronJobs: config.cronJobs.filter((job) => job.name !== params.name),
        };
      });
      configChanged = true;
      await rm(params.workerPath, { force: true });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (configChanged && previousJob) {
        await this.captureRollbackError(rollbackErrors, () => this.restoreRemovedJob(previousJob!));
      }
      await this.captureRollbackError(rollbackErrors, () =>
        this.restoreWorker(params.snapshot, params.workerPath),
      );
      if (previousJob) {
        await this.captureRollbackError(rollbackErrors, () =>
          this.registrar.register(params.workerPath, previousJob!.schedule, previousJob!.name),
        );
      }
      this.throwAfterRollback(error, rollbackErrors);
    }
    return previousJob !== undefined;
  }

  private async readWorker(workerPath: string): Promise<string | undefined> {
    try {
      return await readFile(workerPath, "utf8");
    } catch (error) {
      /* v8 ignore else -- non-ENOENT read failures are propagated unchanged */
      if (this.isMissingFile(error)) return undefined;
      /* v8 ignore next */
      throw error;
    }
  }

  private async restoreReplacedJob(job: RigCronJob, previousJob?: RigCronJob): Promise<void> {
    await this.configStore.update((config) => {
      const current = config.cronJobs.find((candidate) => candidate.name === job.name);
      if (!current || !this.sameJob(current, job)) return config;
      const withoutReplacement = config.cronJobs.filter((candidate) => candidate.name !== job.name);
      return {
        ...config,
        cronJobs: previousJob ? [...withoutReplacement, previousJob] : withoutReplacement,
      };
    });
  }

  private async restoreRemovedJob(previousJob: RigCronJob): Promise<void> {
    await this.configStore.update((config) => {
      if (config.cronJobs.some((job) => job.name === previousJob.name)) return config;
      return { ...config, cronJobs: [...config.cronJobs, previousJob] };
    });
  }

  private async restoreWorker(snapshot: CronWorkerSnapshot, workerPath: string): Promise<void> {
    if (snapshot.workerSource === undefined) {
      await rm(workerPath, { force: true });
      return;
    }
    await this.writeWorker(workerPath, snapshot.workerSource);
  }

  private sameJob(left: RigCronJob, right: RigCronJob): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private async captureRollbackError(
    rollbackErrors: unknown[],
    rollback: () => Promise<void>,
  ): Promise<void> {
    try {
      await rollback();
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  private throwAfterRollback(error: unknown, rollbackErrors: unknown[]): never {
    if (rollbackErrors.length === 0) throw error;
    throw new RigErrorClass("CRON_ERROR", "Cron state rollback was incomplete.", {
      cause: this.errorMessage(error),
      rollbackErrors: rollbackErrors.map((rollbackError) => this.errorMessage(rollbackError)),
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMissingFile(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }

  private async writeWorker(workerPath: string, source: string): Promise<void> {
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(workerPath, source, "utf8");
  }
}

export class RigCronServiceClass {
  private readonly paths: RigPathsClass;
  private readonly configStore: RigConfigStoreClass;
  private readonly inputReader = new CronInputReaderClass();
  private readonly workerScript = new CronWorkerScriptClass();
  private readonly transaction: CronStateTransactionClass;

  constructor(
    private readonly options: ConfigOptions = {},
    private readonly registrar: CronRegistrar = new BunCronRegistrarClass(),
  ) {
    this.paths = new RigPathsClass(options);
    this.configStore = new RigConfigStoreClass(options);
    this.transaction = new CronStateTransactionClass(this.configStore, registrar);
  }

  async list(): Promise<{ cronJobs: RigCronJob[] }> {
    const config = await this.configStore.ensure();
    return {
      cronJobs: [...config.cronJobs].toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async add(options: CronAddOptions): Promise<{ job: RigCronJob; workerPath: string }> {
    const name = new CronJobNameClass(options.name);
    const target = new CronCommandTargetClass(options.command);
    const input = await this.inputReader.read(options);

    this.registrar.validate(options.schedule);
    await this.validateCommand(target, input);

    await this.configStore.ensure();
    const job: RigCronJob = {
      name: name.value,
      command: target.id,
      schedule: options.schedule,
      ...(input === undefined ? {} : { input }),
    };
    const workerPath = this.paths.cronWorkerPath(name.value);
    const workerSource = this.workerScript.render({
      name: name.value,
      homeDir: this.options.homeDir,
      moduleUrl: options.moduleUrl,
    });
    const snapshot = await this.transaction.snapshot(workerPath);
    await this.transaction.replace({
      snapshot,
      workerPath,
      workerSource,
      job,
    });

    return { job, workerPath };
  }

  async remove(nameValue: string): Promise<{ name: string; removed: boolean; workerPath: string }> {
    const name = new CronJobNameClass(nameValue);
    await this.configStore.ensure();
    const workerPath = this.paths.cronWorkerPath(name.value);
    const snapshot = await this.transaction.snapshot(workerPath);
    const removed = await this.transaction.remove({
      snapshot,
      workerPath,
      name: name.value,
    });

    return { name: name.value, removed, workerPath };
  }

  async run(nameValue: string): Promise<CronRunResult> {
    const name = new CronJobNameClass(nameValue);
    const config = await this.configStore.ensure();
    const job = config.cronJobs.find((candidate) => candidate.name === name.value);
    if (!job) throw new RigErrorClass("CRON_ERROR", `Cron job not found: ${name.value}`, { name });

    const target = new CronCommandTargetClass(job.command);
    const result = await new ToolRunnerClass(this.options).run(target.tool, target.command, {
      ...this.options,
      input: job.input === undefined ? undefined : JSON.stringify(job.input),
    });

    return { job, envelope: result.envelope, exitCode: result.exitCode };
  }

  private async validateCommand(
    target: CronCommandTargetClass,
    input: unknown | undefined,
  ): Promise<void> {
    const result = await new ToolRunnerClass(this.options).run(target.tool, target.command, {
      ...this.options,
      input: input === undefined ? undefined : JSON.stringify(input),
      dryRun: true,
    });

    if (result.exitCode !== 0) {
      throw new RigErrorClass("CRON_ERROR", `Cron command validation failed: ${target.id}`, {
        envelope: result.envelope,
      });
    }
  }
}

export class RigCronWorkerClass {
  constructor(private readonly options: ConfigOptions = {}) {}

  async scheduled(name: string, controller?: CronControllerLike): Promise<void> {
    const result = await new RigCronServiceClass(this.options).run(name);
    const envelope = result.envelope as Partial<SuccessEnvelope>;
    console.log(
      JSON.stringify(
        {
          cron: {
            name: result.job.name,
            command: result.job.command,
            schedule: controller?.cron ?? result.job.schedule,
            scheduledTime: controller?.scheduledTime,
            type: controller?.type,
          },
          result: envelope,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.exitCode;
  }
}

export { RigCronWorkerClass as RigCronWorker };

export function cronModuleUrl(metaUrl: string): string {
  return pathToFileURL(fileURLToPath(metaUrl)).href;
}
