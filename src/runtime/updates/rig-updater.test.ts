import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import {
  RigUpdateCommandRunnerClass,
  RigUpdaterClass,
  RigUpdaterFactoryClass,
  type RigUpdatePlan,
  type RigUpdateStep,
} from "./rig-updater";

const npmRoot = "/runtime/lib/node_modules/@rendotdev/rig";
const npmExecutable = "/runtime/bin/npm";
const rigExecutable = "/runtime/bin/rig";
const bunRoot = "/Users/ren/.bun/install/global/node_modules/@rendotdev/rig";
const bunExecutable = "/Users/ren/.bun/bin/bun";
const bunRigExecutable = "/Users/ren/.bun/bin/rig";

class RigUpdaterTestContextClass {
  public readonly reads: RigUpdateStep[] = [];
  public readonly runs: RigUpdateStep[] = [];
  public latestOutput = '"0.0.42"';
  public versionOutput = "0.0.42\n";
  public runOutput = "changed 1 package\n";
  public readonly executablePaths = new Set([npmExecutable, rigExecutable]);

  public create(params: { packageRoot?: string; currentVersion?: string } = {}): RigUpdaterClass {
    return new RigUpdaterClass(
      {
        packageRoot: params.packageRoot ?? npmRoot,
        currentVersion: params.currentVersion ?? "0.0.41",
      },
      {
        executableExists: (path) => this.executablePaths.has(path),
        readCommand: async (step) => {
          this.reads.push(step);
          return step.args.includes("--version") ? this.versionOutput : this.latestOutput;
        },
        runCommand: async (step) => {
          this.runs.push(step);
          return this.runOutput;
        },
      },
    );
  }
}

describe("RigUpdateCommandRunnerClass", () => {
  const Runner = new RigUpdateCommandRunnerClass({}, { spawn, env: { RIG_TEST: "inherited" } });

  it("captures stdout and stderr for run and read operations", async () => {
    const script =
      'process.stdout.write(process.env.RIG_TEST ?? ""); process.stderr.write(process.env.EXTRA ?? "")';
    const step = { command: process.execPath, args: ["-e", script], env: { EXTRA: " added" } };

    expect(await Runner.run(step)).toBe("inherited added");
    expect(await Runner.read(step)).toBe("inherited added");
  });

  it("reports command output when a process exits unsuccessfully", async () => {
    await expect(
      Runner.run({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("registry failed"); process.exit(2)'],
      }),
    ).rejects.toThrow(`${process.execPath} exited with code 2.\nregistry failed`);
  });

  it("reports a terminating signal without empty output", async () => {
    await expect(Runner.run({ command: "/bin/sh", args: ["-c", "kill -TERM $$"] })).rejects.toThrow(
      "/bin/sh exited with SIGTERM.",
    );
  });

  it("forwards process spawn errors", async () => {
    await expect(
      Runner.run({ command: "/path/that/does/not/exist", args: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an unknown exit when a process has no code or signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawnWithoutExitStatus = function spawnWithoutExitStatus() {
      queueMicrotask(function finishWithoutStatus() {
        child.emit("exit", null, null);
      });
      return child;
    } as unknown as typeof spawn;
    const UnknownExitRunner = new RigUpdateCommandRunnerClass(
      {},
      { spawn: spawnWithoutExitStatus, env: {} },
    );

    await expect(UnknownExitRunner.run({ command: "mystery", args: [] })).rejects.toThrow(
      "mystery exited with code unknown.",
    );
  });
});

describe("RigUpdaterClass", () => {
  it("plans, installs, verifies, and synchronizes an npm update", async () => {
    const Context = new RigUpdaterTestContextClass();
    const Updater = Context.create();

    expect(Updater.getCurrentVersion()).toBe("0.0.41");
    const plan = await Updater.plan();
    expect(plan).toEqual({
      status: "ready",
      currentVersion: "0.0.41",
      latestVersion: "0.0.42",
      updateStep: {
        command: npmExecutable,
        args: ["install", "--global", "--prefix", "/runtime", "@rendotdev/rig@0.0.42"],
      },
      versionStep: { command: rigExecutable, args: ["--version"] },
      syncStep: {
        command: rigExecutable,
        args: ["init"],
        env: { RIG_UPDATE_CHECK: "0" },
      },
    });
    expect(Context.reads[0]).toEqual({
      command: npmExecutable,
      args: ["view", "@rendotdev/rig@latest", "version", "--json"],
    });

    const result = await Updater.update({ plan });
    expect(result).toEqual({
      status: "updated",
      previousVersion: "0.0.41",
      version: "0.0.42",
      step: plan.status === "ready" ? plan.updateStep : undefined,
      output: "changed 1 package\n",
    });

    if (plan.status !== "ready") throw new Error("Expected a runnable update plan.");
    await expect(Updater.sync({ plan })).resolves.toEqual({
      step: plan.syncStep,
      output: "changed 1 package\n",
    });
    expect(Context.runs).toEqual([plan.updateStep, plan.syncStep]);
  });

  it("returns a current plan and can resolve it through update", async () => {
    const Context = new RigUpdaterTestContextClass();
    Context.latestOutput = '"0.0.41"';
    const Updater = Context.create();

    const plan = await Updater.plan();
    expect(plan).toMatchObject({ status: "current", version: "0.0.41" });
    await expect(Updater.update({ plan })).resolves.toMatchObject({
      status: "current",
      version: "0.0.41",
    });
    await expect(Updater.update({})).resolves.toMatchObject({
      status: "current",
      version: "0.0.41",
    });
  });

  it("supports Bun global installations and plain registry output", async () => {
    const Context = new RigUpdaterTestContextClass();
    Context.executablePaths.clear();
    Context.executablePaths.add(bunExecutable);
    Context.executablePaths.add(bunRigExecutable);
    Context.latestOutput = "0.0.42\n";

    await expect(Context.create({ packageRoot: bunRoot }).plan()).resolves.toMatchObject({
      status: "ready",
      updateStep: {
        command: bunExecutable,
        args: ["install", "--global", "@rendotdev/rig@0.0.42"],
      },
      versionStep: { command: bunRigExecutable, args: ["--version"] },
    });
    expect(Context.reads).toEqual([
      {
        command: bunExecutable,
        args: ["pm", "view", "@rendotdev/rig@latest", "version"],
      },
    ]);
  });

  it("skips unsupported package layouts", async () => {
    const Context = new RigUpdaterTestContextClass();

    await expect(Context.create({ packageRoot: "/checkout/rig" }).plan()).resolves.toEqual({
      status: "skipped",
      reason: "Rig is not running from a supported global npm or Bun installation.",
    });
    await expect(
      Context.create({ packageRoot: "/runtime/node_modules/@rendotdev/rig" }).plan(),
    ).resolves.toEqual({
      status: "skipped",
      reason: "Rig is not running from a supported global npm or Bun installation.",
    });
  });

  it("skips installations with missing package manager or Rig executables", async () => {
    const MissingPackageManager = new RigUpdaterTestContextClass();
    MissingPackageManager.executablePaths.delete(npmExecutable);
    await expect(MissingPackageManager.create().plan()).resolves.toEqual({
      status: "skipped",
      reason: `The package manager for this Rig installation was not found at ${npmExecutable}.`,
    });

    const MissingRig = new RigUpdaterTestContextClass();
    MissingRig.executablePaths.delete(rigExecutable);
    await expect(MissingRig.create().plan()).resolves.toEqual({
      status: "skipped",
      reason: `The Rig executable for this installation was not found at ${rigExecutable}.`,
    });
  });

  it("rejects empty, non-string, and malformed latest versions", async () => {
    await Promise.all(
      ['""', "42", "not-a-version"].map(async function rejectOutput(output) {
        const Context = new RigUpdaterTestContextClass();
        Context.latestOutput = output;
        await expect(Context.create().plan()).rejects.toThrow(
          "The package manager returned an invalid latest Rig version.",
        );
      }),
    );
  });

  it("accepts prerelease versions", async () => {
    const Context = new RigUpdaterTestContextClass();
    Context.latestOutput = '"0.1.0-beta.1"';

    await expect(Context.create().plan()).resolves.toMatchObject({
      status: "ready",
      latestVersion: "0.1.0-beta.1",
    });
  });

  it("rejects a mismatched or missing installed version", async () => {
    await Promise.all(
      ["0.0.43\n", "\n"].map(async function rejectVersion(versionOutput) {
        const Context = new RigUpdaterTestContextClass();
        Context.versionOutput = versionOutput;
        const Updater = Context.create();
        const plan = await Updater.plan();

        await expect(Updater.update({ plan })).rejects.toThrow(
          `Rig reported version ${versionOutput.trim() || "unknown"} after updating to 0.0.42.`,
        );
      }),
    );
  });

  it("returns a supplied skipped plan without running commands", async () => {
    const Context = new RigUpdaterTestContextClass();
    const plan: RigUpdatePlan = { status: "skipped", reason: "Development checkout." };

    await expect(Context.create().update({ plan })).resolves.toBe(plan);
    expect(Context.runs).toEqual([]);
  });
});

describe("RigUpdaterFactoryClass", () => {
  it("creates an updater using its process dependencies", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const spawnCommand = function spawnCommand(
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) {
      calls.push({ command, args });
      const output = args.includes("--version")
        ? "0.0.42"
        : args.includes("install")
          ? "installed"
          : '"0.0.42"';
      return spawn(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        options,
      );
    } as typeof spawn;
    const Factory = new RigUpdaterFactoryClass(
      {},
      {
        spawn: spawnCommand,
        env: {},
        executableExists(path) {
          return path === npmExecutable || path === rigExecutable;
        },
      },
    );
    const Updater = Factory.create({ packageRoot: npmRoot, currentVersion: "0.0.41" });

    const plan = await Updater.plan();
    await expect(Updater.update({ plan })).resolves.toMatchObject({ status: "updated" });
    expect(calls).toEqual([
      {
        command: npmExecutable,
        args: ["view", "@rendotdev/rig@latest", "version", "--json"],
      },
      {
        command: npmExecutable,
        args: ["install", "--global", "--prefix", "/runtime", "@rendotdev/rig@0.0.42"],
      },
      { command: rigExecutable, args: ["--version"] },
    ]);
  });
});
