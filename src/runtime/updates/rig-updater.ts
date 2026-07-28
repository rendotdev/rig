import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type * as Layer from "effect/Layer";
import {
  applyUpdate,
  makeRigUpdaterLayer,
  planUpdate,
  RigUpdaterRuntimeService,
  syncUpdate,
} from "./rig-updater-effect-service";

export type RigUpdateStep = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export type RigUpdatePlan =
  | {
      status: "ready";
      currentVersion: string;
      latestVersion: string;
      updateStep: RigUpdateStep;
      versionStep: RigUpdateStep;
      syncStep: RigUpdateStep;
    }
  | { status: "current"; version: string; syncStep: RigUpdateStep }
  | { status: "skipped"; reason: string };

export type RigUpdateResult =
  | {
      status: "updated";
      previousVersion: string;
      version: string;
      step: RigUpdateStep;
      output: string;
    }
  | { status: "current"; version: string }
  | { status: "skipped"; reason: string };

export type RunnableRigUpdatePlan = Exclude<RigUpdatePlan, { status: "skipped" }>;

type RigUpdateCommandRunnerDeps = {
  spawn: typeof spawn;
  env: NodeJS.ProcessEnv;
};

const RigUpdateCommandRunnerProductionDeps: RigUpdateCommandRunnerDeps = {
  spawn,
  env: process.env,
};

export class RigUpdateCommandRunnerService {
  public static readonly defaultConstruction = {
    params: {},
    deps: RigUpdateCommandRunnerProductionDeps,
  };
  protected readonly params: (typeof RigUpdateCommandRunnerService.defaultConstruction)["params"];
  protected readonly deps: (typeof RigUpdateCommandRunnerService.defaultConstruction)["deps"];

  public constructor(
    props: typeof RigUpdateCommandRunnerService.defaultConstruction = RigUpdateCommandRunnerService.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
  }

  private async execute(params: RigUpdateStep): Promise<string> {
    return await new Promise<string>((resolvePromise, reject) => {
      const child = this.deps.spawn(params.command, params.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...this.deps.env, ...params.env },
      });
      const output: Buffer[] = [];
      child.stdout.on("data", function captureStdout(chunk: Buffer | string) {
        output.push(Buffer.from(chunk));
      });
      child.stderr.on("data", function captureStderr(chunk: Buffer | string) {
        output.push(Buffer.from(chunk));
      });
      child.once("error", reject);
      child.once("exit", function handleExit(code, signal) {
        if (code === 0) {
          resolvePromise(Buffer.concat(output).toString("utf8"));
          return;
        }
        const detail = Buffer.concat(output).toString("utf8").trim();
        reject(
          new Error(
            `${params.command} exited with ${signal ?? `code ${code ?? "unknown"}`}.${detail ? `\n${detail}` : ""}`,
          ),
        );
      });
    });
  }

  public async run(params: RigUpdateStep): Promise<string> {
    return await this.execute(params);
  }

  public async read(params: RigUpdateStep): Promise<string> {
    return await this.execute(params);
  }
}

export const RigUpdateCommandRunner = new RigUpdateCommandRunnerService();

export type RigUpdateCommandRunnerClass = {
  run(params: RigUpdateStep): Promise<string>;
  read(params: RigUpdateStep): Promise<string>;
};

type RigUpdateCommandRunnerConstructor = {
  new (params: {}, deps: RigUpdateCommandRunnerDeps): RigUpdateCommandRunnerClass;
  readonly prototype: RigUpdateCommandRunnerClass;
};

type RigUpdateCommandRunnerAdapter = RigUpdateCommandRunnerClass & {
  readonly resource: RigUpdateCommandRunnerService;
};

const RigUpdateCommandRunnerClassAdapter = function constructRigUpdateCommandRunner(
  this: RigUpdateCommandRunnerAdapter,
  _params: {},
  deps: RigUpdateCommandRunnerDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new RigUpdateCommandRunnerService({ params: {}, deps }),
  });
};
Object.defineProperty(RigUpdateCommandRunnerClassAdapter, "name", {
  value: "RigUpdateCommandRunnerClass",
});
Object.defineProperties(RigUpdateCommandRunnerClassAdapter.prototype, {
  run: {
    configurable: true,
    value: function run(this: RigUpdateCommandRunnerAdapter, params: RigUpdateStep) {
      return this.resource.run(params);
    },
    writable: true,
  },
  read: {
    configurable: true,
    value: function read(this: RigUpdateCommandRunnerAdapter, params: RigUpdateStep) {
      return this.resource.read(params);
    },
    writable: true,
  },
});

export const RigUpdateCommandRunnerClass =
  RigUpdateCommandRunnerClassAdapter as unknown as RigUpdateCommandRunnerConstructor;

type RigUpdaterDeps = {
  executableExists: (path: string) => boolean;
  readCommand: (step: RigUpdateStep) => Promise<string>;
  runCommand: (step: RigUpdateStep) => Promise<string>;
  basename: typeof basename;
  dirname: typeof dirname;
  join: typeof join;
  resolve: typeof resolve;
};

const RigUpdaterProductionDeps: RigUpdaterDeps = {
  executableExists: existsSync,
  /* v8 ignore start -- these default delegates would query and mutate the real global package manager; injected runner behavior is covered below. */
  readCommand(params) {
    return RigUpdateCommandRunner.read(params);
  },
  runCommand(params) {
    return RigUpdateCommandRunner.run(params);
  },
  /* v8 ignore stop */
  basename,
  dirname,
  join,
  resolve,
};

type RigInstallation =
  | { kind: "npm" | "bun"; packageManager: string; prefix: string; rig: string }
  | { reason: string };

function resolveInstallation(params: {
  packageRoot: string;
  basename: typeof basename;
  dirname: typeof dirname;
  join: typeof join;
}): RigInstallation {
  const scopeDirectory = params.dirname(params.packageRoot);
  const nodeModulesDirectory = params.dirname(scopeDirectory);
  if (
    params.basename(params.packageRoot) !== "rig" ||
    params.basename(scopeDirectory) !== "@rendotdev" ||
    params.basename(nodeModulesDirectory) !== "node_modules"
  ) {
    return { reason: "Rig is not running from a supported global npm or Bun installation." };
  }

  const parentDirectory = params.dirname(nodeModulesDirectory);
  if (params.basename(parentDirectory) === "lib") {
    const prefix = params.dirname(parentDirectory);
    return {
      kind: "npm",
      packageManager: params.join(prefix, "bin", "npm"),
      prefix,
      rig: params.join(prefix, "bin", "rig"),
    };
  }

  const installDirectory = params.dirname(parentDirectory);
  const bunDirectory = params.dirname(installDirectory);
  if (
    params.basename(parentDirectory) === "global" &&
    params.basename(installDirectory) === "install" &&
    params.basename(bunDirectory) === ".bun"
  ) {
    return {
      kind: "bun",
      packageManager: params.join(bunDirectory, "bin", "bun"),
      prefix: bunDirectory,
      rig: params.join(bunDirectory, "bin", "rig"),
    };
  }

  return { reason: "Rig is not running from a supported global npm or Bun installation." };
}

function parseLatestVersion(params: { output: string }): string {
  let value: unknown;
  try {
    value = JSON.parse(params.output);
  } catch {
    value = params.output.trim();
  }
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())) {
    throw new Error("The package manager returned an invalid latest Rig version.");
  }
  return value.trim();
}

export class RigUpdaterService {
  public static readonly defaultConstruction = {
    params: { packageRoot: "", currentVersion: "" },
    deps: RigUpdaterProductionDeps,
  };
  protected readonly params: (typeof RigUpdaterService.defaultConstruction)["params"];
  protected readonly deps: (typeof RigUpdaterService.defaultConstruction)["deps"];

  public constructor(
    props: typeof RigUpdaterService.defaultConstruction = RigUpdaterService.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
    this.packageRoot = this.deps.resolve(this.params.packageRoot);
  }

  private readonly packageRoot: string;

  public getCurrentVersion(_params: {}): string {
    return this.params.currentVersion;
  }

  public async plan(_params: {}): Promise<RigUpdatePlan> {
    const installation = resolveInstallation({
      packageRoot: this.packageRoot,
      basename: this.deps.basename,
      dirname: this.deps.dirname,
      join: this.deps.join,
    });
    if ("reason" in installation) return { status: "skipped", reason: installation.reason };
    if (!this.deps.executableExists(installation.packageManager)) {
      return {
        status: "skipped",
        reason: `The package manager for this Rig installation was not found at ${installation.packageManager}.`,
      };
    }
    if (!this.deps.executableExists(installation.rig)) {
      return {
        status: "skipped",
        reason: `The Rig executable for this installation was not found at ${installation.rig}.`,
      };
    }

    const latestVersion = parseLatestVersion({
      output: await this.deps.readCommand({
        command: installation.packageManager,
        args:
          installation.kind === "npm"
            ? ["view", "@rendotdev/rig@latest", "version", "--json"]
            : ["pm", "view", "@rendotdev/rig@latest", "version"],
      }),
    });
    const syncStep = {
      command: installation.rig,
      args: ["init"],
      env: { RIG_UPDATE_CHECK: "0" },
    };
    if (latestVersion === this.params.currentVersion) {
      return { status: "current", version: this.params.currentVersion, syncStep };
    }

    return {
      status: "ready",
      currentVersion: this.params.currentVersion,
      latestVersion,
      updateStep: {
        command: installation.packageManager,
        args:
          installation.kind === "npm"
            ? [
                "install",
                "--global",
                "--prefix",
                installation.prefix,
                `@rendotdev/rig@${latestVersion}`,
              ]
            : ["install", "--global", `@rendotdev/rig@${latestVersion}`],
      },
      versionStep: { command: installation.rig, args: ["--version"] },
      syncStep,
    };
  }

  public async update(params: { plan?: RigUpdatePlan }): Promise<RigUpdateResult> {
    const updatePlan = params.plan ?? (await this.plan({}));
    switch (updatePlan.status) {
      case "current":
        return { status: "current", version: updatePlan.version };
      case "skipped":
        return updatePlan;
      case "ready":
        break;
    }
    const output = await this.deps.runCommand(updatePlan.updateStep);
    const version = (await this.deps.readCommand(updatePlan.versionStep)).trim();
    if (version !== updatePlan.latestVersion) {
      throw new Error(
        `Rig reported version ${version || "unknown"} after updating to ${updatePlan.latestVersion}.`,
      );
    }
    return {
      status: "updated",
      previousVersion: updatePlan.currentVersion,
      version,
      step: updatePlan.updateStep,
      output,
    };
  }

  public async sync(params: { plan: RunnableRigUpdatePlan }): Promise<{
    step: RigUpdateStep;
    output: string;
  }> {
    return {
      step: params.plan.syncStep,
      output: await this.deps.runCommand(params.plan.syncStep),
    };
  }
}

type RigUpdaterConstructorDeps = Pick<
  RigUpdaterDeps,
  "executableExists" | "readCommand" | "runCommand"
>;

function buildRigUpdater(params: {
  params: { packageRoot: string; currentVersion: string };
  deps: RigUpdaterConstructorDeps;
}): RigUpdaterService {
  return new RigUpdaterService({
    params: params.params,
    deps: {
      ...params.deps,
      basename,
      dirname,
      join,
      resolve,
    },
  });
}

export class RigUpdaterClass {
  public readonly resource: RigUpdaterService;
  public readonly layer: Layer.Layer<RigUpdaterRuntimeService>;

  public constructor(
    params: { packageRoot: string; currentVersion: string },
    deps: RigUpdaterConstructorDeps,
  ) {
    this.resource = buildRigUpdater({ params, deps });
    this.layer = makeRigUpdaterLayer(this.resource);
  }

  public getCurrentVersion(): string {
    return this.resource.getCurrentVersion({});
  }

  public plan(): Promise<RigUpdatePlan> {
    return planUpdate(this.layer);
  }

  public update(params: { plan?: RigUpdatePlan }): Promise<RigUpdateResult> {
    return applyUpdate(this.layer, params.plan);
  }

  public sync(params: { plan: RunnableRigUpdatePlan }) {
    return syncUpdate(this.layer, params.plan);
  }
}

type RigUpdaterFactoryDeps = {
  spawn: typeof spawn;
  env: NodeJS.ProcessEnv;
  executableExists: (path: string) => boolean;
};

const RigUpdaterFactoryProductionDeps: RigUpdaterFactoryDeps = {
  spawn,
  env: process.env,
  executableExists: existsSync,
};

export class RigUpdaterFactoryService {
  public static readonly defaultConstruction = {
    params: {},
    deps: RigUpdaterFactoryProductionDeps,
  };
  protected readonly params: (typeof RigUpdaterFactoryService.defaultConstruction)["params"];
  protected readonly deps: (typeof RigUpdaterFactoryService.defaultConstruction)["deps"];

  public constructor(
    props: typeof RigUpdaterFactoryService.defaultConstruction = RigUpdaterFactoryService.defaultConstruction,
  ) {
    this.params = props.params;
    this.deps = props.deps;
  }

  public create(params: { packageRoot: string; currentVersion: string }): RigUpdaterService {
    const runner = new RigUpdateCommandRunnerService({
      params: {},
      deps: { spawn: this.deps.spawn, env: this.deps.env },
    });
    return buildRigUpdater({
      params,
      deps: {
        executableExists: this.deps.executableExists,
        readCommand: runner.read.bind(runner),
        runCommand: runner.run.bind(runner),
      },
    });
  }
}

export type RigUpdaterFactoryClass = {
  create(params: { packageRoot: string; currentVersion: string }): RigUpdaterClass;
};

type RigUpdaterFactoryConstructor = {
  new (params: {}, deps: RigUpdaterFactoryDeps): RigUpdaterFactoryClass;
  readonly prototype: RigUpdaterFactoryClass;
};

type RigUpdaterFactoryAdapter = RigUpdaterFactoryClass & {
  readonly resource: RigUpdaterFactoryService;
};

function adaptRigUpdaterResource(resource: RigUpdaterService): RigUpdaterClass {
  const adapter = Object.create(RigUpdaterClass.prototype) as RigUpdaterClass;
  Object.defineProperties(adapter, {
    resource: { value: resource },
    layer: { value: makeRigUpdaterLayer(resource) },
  });
  return adapter;
}

const RigUpdaterFactoryClassAdapter = function constructRigUpdaterFactory(
  this: RigUpdaterFactoryAdapter,
  _params: {},
  deps: RigUpdaterFactoryDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new RigUpdaterFactoryService({ params: {}, deps }),
  });
};
Object.defineProperty(RigUpdaterFactoryClassAdapter, "name", { value: "RigUpdaterFactoryClass" });
Object.defineProperty(RigUpdaterFactoryClassAdapter.prototype, "create", {
  configurable: true,
  value: function create(
    this: RigUpdaterFactoryAdapter,
    params: { packageRoot: string; currentVersion: string },
  ): RigUpdaterClass {
    return adaptRigUpdaterResource(this.resource.create(params));
  },
  writable: true,
});

export const RigUpdaterFactoryClass =
  RigUpdaterFactoryClassAdapter as unknown as RigUpdaterFactoryConstructor;
export const RigUpdaterFactory = new RigUpdaterFactoryClass({}, RigUpdaterFactoryProductionDeps);
