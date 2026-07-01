import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConfigOptions } from "../config/config";
import { RigConfigStore } from "../config/config";
import { RigPaths } from "../config/paths";
import type { RigCronJob } from "../config/schema";
import { RigError } from "../errors/RigError";
import type { SuccessEnvelope } from "../runtime/envelope";
import { ToolRunner } from "./run";

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

class BunCronRegistrar implements CronRegistrar {
  register(path: string, schedule: string, title: string): Promise<void> {
    return this.cron()(path, schedule, title);
  }

  remove(title: string): Promise<void> {
    return this.cron().remove(title);
  }

  validate(schedule: string): void {
    const next = this.cron().parse(schedule);
    if (!next) throw new RigError("CRON_ERROR", `Cron schedule has no future runs: ${schedule}`);
  }

  private cron(): BunCronApi {
    const cron = (globalThis as typeof globalThis & { Bun?: { cron?: unknown } }).Bun?.cron;
    /* v8 ignore next 3 */
    if (typeof cron !== "function") {
      throw new RigError("CRON_ERROR", "Bun cron is unavailable. Run rig with Bun.");
    }
    return cron as BunCronApi;
  }
}

class CronJobName {
  constructor(readonly value: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new RigError(
        "INPUT_ERROR",
        "Cron job names may only contain letters, numbers, hyphens, and underscores.",
        { name: value },
      );
    }
  }
}

class CronInputReader {
  async read(options: { input?: string; inputFile?: string }): Promise<unknown | undefined> {
    if (options.input && options.inputFile) {
      throw new RigError("INPUT_ERROR", "Use --input or --input-file, not both.");
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

class CronCommandTarget {
  readonly tool: string;
  readonly command: string;

  constructor(readonly id: string) {
    const parts = id.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new RigError("INPUT_ERROR", `Command id must use <tool>.<command>: ${id}`);
    }
    this.tool = parts[0];
    this.command = parts[1];
  }
}

class CronWorkerScript {
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

export class RigCronService {
  private readonly paths: RigPaths;
  private readonly configStore: RigConfigStore;
  private readonly inputReader = new CronInputReader();
  private readonly workerScript = new CronWorkerScript();

  constructor(
    private readonly options: ConfigOptions = {},
    private readonly registrar: CronRegistrar = new BunCronRegistrar(),
  ) {
    this.paths = new RigPaths(options);
    this.configStore = new RigConfigStore(options);
  }

  async list(): Promise<{ cronJobs: RigCronJob[] }> {
    const config = await this.configStore.ensure();
    return {
      cronJobs: [...config.cronJobs].toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async add(options: CronAddOptions): Promise<{ job: RigCronJob; workerPath: string }> {
    const name = new CronJobName(options.name);
    const target = new CronCommandTarget(options.command);
    const input = await this.inputReader.read(options);

    this.registrar.validate(options.schedule);
    await this.validateCommand(target, input);

    const config = await this.configStore.ensure();
    const job: RigCronJob = {
      name: name.value,
      command: target.id,
      schedule: options.schedule,
      ...(input === undefined ? {} : { input }),
    };
    const workerPath = this.paths.cronWorkerPath(name.value);

    await this.writeWorker(workerPath, {
      name: name.value,
      homeDir: this.options.homeDir,
      moduleUrl: options.moduleUrl,
    });
    await this.configStore.write({
      ...config,
      cronJobs: [...config.cronJobs.filter((existing) => existing.name !== name.value), job],
    });
    try {
      await this.registrar.register(workerPath, options.schedule, name.value);
    } catch (error) {
      await this.configStore.write(config);
      await rm(workerPath, { force: true });
      throw error;
    }

    return { job, workerPath };
  }

  async remove(nameValue: string): Promise<{ name: string; removed: boolean; workerPath: string }> {
    const name = new CronJobName(nameValue);
    const config = await this.configStore.ensure();
    const workerPath = this.paths.cronWorkerPath(name.value);
    const nextJobs = config.cronJobs.filter((job) => job.name !== name.value);

    await this.configStore.write({ ...config, cronJobs: nextJobs });
    await this.registrar.remove(name.value);
    await rm(workerPath, { force: true });

    return { name: name.value, removed: nextJobs.length !== config.cronJobs.length, workerPath };
  }

  async run(nameValue: string): Promise<CronRunResult> {
    const name = new CronJobName(nameValue);
    const config = await this.configStore.ensure();
    const job = config.cronJobs.find((candidate) => candidate.name === name.value);
    if (!job) throw new RigError("CRON_ERROR", `Cron job not found: ${name.value}`, { name });

    const target = new CronCommandTarget(job.command);
    const result = await new ToolRunner(this.options).run(target.tool, target.command, {
      ...this.options,
      input: job.input === undefined ? undefined : JSON.stringify(job.input),
    });

    return { job, envelope: result.envelope, exitCode: result.exitCode };
  }

  private async validateCommand(
    target: CronCommandTarget,
    input: unknown | undefined,
  ): Promise<void> {
    const result = await new ToolRunner(this.options).run(target.tool, target.command, {
      ...this.options,
      input: input === undefined ? undefined : JSON.stringify(input),
      dryRun: true,
    });

    if (result.exitCode !== 0) {
      throw new RigError("CRON_ERROR", `Cron command validation failed: ${target.id}`, {
        envelope: result.envelope,
      });
    }
  }

  private async writeWorker(
    workerPath: string,
    params: { name: string; homeDir?: string; moduleUrl: string },
  ): Promise<void> {
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(workerPath, this.workerScript.render(params), "utf8");
  }
}

export class RigCronWorker {
  constructor(private readonly options: ConfigOptions = {}) {}

  async scheduled(name: string, controller?: CronControllerLike): Promise<void> {
    const result = await new RigCronService(this.options).run(name);
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

export function cronModuleUrl(metaUrl: string): string {
  return pathToFileURL(fileURLToPath(metaUrl)).href;
}
