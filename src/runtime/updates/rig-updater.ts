import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DomainClass } from "../../domain/domain-class";

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

type RunnableRigUpdatePlan = Exclude<RigUpdatePlan, { status: "skipped" }>;

export class RigUpdateCommandRunnerClass extends DomainClass<
  {},
  { spawn: typeof spawn; env: NodeJS.ProcessEnv }
> {
  public async run(params: RigUpdateStep): Promise<string> {
    return await this.execute(params);
  }

  public async read(params: RigUpdateStep): Promise<string> {
    return await this.execute(params);
  }

  private async execute(params: RigUpdateStep): Promise<string> {
    const { spawn: spawnCommand } = this.deps;
    const inheritedEnv = this.deps.env;
    return await new Promise<string>(function runCommand(resolvePromise, reject) {
      const child = spawnCommand(params.command, params.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...inheritedEnv, ...params.env },
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
}

export class RigUpdaterClass extends DomainClass<
  { packageRoot: string; currentVersion: string },
  {
    executableExists: (path: string) => boolean;
    readCommand: (step: RigUpdateStep) => Promise<string>;
    runCommand: (step: RigUpdateStep) => Promise<string>;
  }
> {
  public constructor(
    params: { packageRoot: string; currentVersion: string },
    deps: {
      executableExists: (path: string) => boolean;
      readCommand: (step: RigUpdateStep) => Promise<string>;
      runCommand: (step: RigUpdateStep) => Promise<string>;
    },
  ) {
    super({ ...params, packageRoot: resolve(params.packageRoot) }, deps);
  }

  public getCurrentVersion(): string {
    return this.params.currentVersion;
  }

  public async plan(): Promise<RigUpdatePlan> {
    const installation = this.resolveInstallation();
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

    const latestVersion = this.parseLatestVersion(
      await this.deps.readCommand({
        command: installation.packageManager,
        args:
          installation.kind === "npm"
            ? ["view", "@rendotdev/rig@latest", "version", "--json"]
            : ["pm", "view", "@rendotdev/rig@latest", "version"],
      }),
    );
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
    const plan = params.plan ?? (await this.plan());
    switch (plan.status) {
      case "current":
        return { status: "current", version: plan.version };
      case "skipped":
        return plan;
      case "ready":
        break;
    }
    const output = await this.deps.runCommand(plan.updateStep);
    const version = (await this.deps.readCommand(plan.versionStep)).trim();
    if (version !== plan.latestVersion) {
      throw new Error(
        `Rig reported version ${version || "unknown"} after updating to ${plan.latestVersion}.`,
      );
    }
    return {
      status: "updated",
      previousVersion: plan.currentVersion,
      version,
      step: plan.updateStep,
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

  private resolveInstallation():
    | { kind: "npm" | "bun"; packageManager: string; prefix: string; rig: string }
    | { reason: string } {
    const scopeDirectory = dirname(this.params.packageRoot);
    const nodeModulesDirectory = dirname(scopeDirectory);
    if (
      basename(this.params.packageRoot) !== "rig" ||
      basename(scopeDirectory) !== "@rendotdev" ||
      basename(nodeModulesDirectory) !== "node_modules"
    ) {
      return { reason: "Rig is not running from a supported global npm or Bun installation." };
    }

    const parentDirectory = dirname(nodeModulesDirectory);
    if (basename(parentDirectory) === "lib") {
      const prefix = dirname(parentDirectory);
      return {
        kind: "npm",
        packageManager: join(prefix, "bin", "npm"),
        prefix,
        rig: join(prefix, "bin", "rig"),
      };
    }

    const installDirectory = dirname(parentDirectory);
    const bunDirectory = dirname(installDirectory);
    if (
      basename(parentDirectory) === "global" &&
      basename(installDirectory) === "install" &&
      basename(bunDirectory) === ".bun"
    ) {
      return {
        kind: "bun",
        packageManager: join(bunDirectory, "bin", "bun"),
        prefix: bunDirectory,
        rig: join(bunDirectory, "bin", "rig"),
      };
    }

    return { reason: "Rig is not running from a supported global npm or Bun installation." };
  }

  private parseLatestVersion(output: string): string {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      value = output.trim();
    }
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())) {
      throw new Error("The package manager returned an invalid latest Rig version.");
    }
    return value.trim();
  }
}

export class RigUpdaterFactoryClass extends DomainClass<
  {},
  { spawn: typeof spawn; env: NodeJS.ProcessEnv; executableExists: (path: string) => boolean }
> {
  public create(params: { packageRoot: string; currentVersion: string }): RigUpdaterClass {
    const Runner = new RigUpdateCommandRunnerClass(
      {},
      { spawn: this.deps.spawn, env: this.deps.env },
    );
    return new RigUpdaterClass(params, {
      executableExists: this.deps.executableExists,
      readCommand: function readCommand(step) {
        return Runner.read(step);
      },
      runCommand: function runCommand(step) {
        return Runner.run(step);
      },
    });
  }
}

export const RigUpdaterFactory = new RigUpdaterFactoryClass(
  {},
  { spawn, env: process.env, executableExists: existsSync },
);
