import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  ManagedProcessConfigService,
  ManagedProcessService,
} from "../../../../src/providers/process/managed-process";
import {
  RigShellConfigService,
  type RigShellChildProcess,
  RigShellPlatformService,
  RigShellService,
  ShellOutputService,
  ShellProcessService,
  ShellTemplateService,
} from "../../../../src/providers/process/rig-shell-service";
import { RigUpdaterConfigService } from "../../../../src/domains/updates/config/rig-updater-config";
import {
  RigUpdateCommandRunnerService,
  RigUpdaterPlatformService,
  rigUpdateCommandRunnerLayer,
} from "../../../../src/domains/updates/repo/rig-updater-repository";
import {
  type RigUpdatePlan,
  RigUpdateError,
  type RigUpdateStep,
} from "../../../../src/domains/updates/types/updates";
import {
  RigUpdaterService,
  rigUpdaterOperationLayer,
} from "../../../../src/domains/updates/runtime/rig-updater";

const npmRoot = "/runtime/lib/node_modules/@rendotdev/rig";
const npmExecutable = "/runtime/bin/npm";
const rigExecutable = "/runtime/bin/rig";
const bunRoot = "/Users/ren/.bun/install/global/node_modules/@rendotdev/rig";
const bunExecutable = "/Users/ren/.bun/bin/bun";
const bunRigExecutable = "/Users/ren/.bun/bin/rig";

class RigUpdaterTestContext {
  public readonly reads: RigUpdateStep[] = [];
  public readonly runs: RigUpdateStep[] = [];
  public latestOutput = '"0.0.42"';
  public versionOutput = "0.0.42\n";
  public runOutput = "changed 1 package\n";
  public readonly executablePaths = new Set([npmExecutable, rigExecutable]);

  public create(params: { packageRoot?: string; currentVersion?: string } = {}) {
    const executablePaths = this.executablePaths;
    const reads = this.reads;
    const runs = this.runs;
    const versionOutput = this.versionOutput;
    const latestOutput = this.latestOutput;
    const runOutput = this.runOutput;
    const updaterLayer = rigUpdaterOperationLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RigUpdaterConfigService, {
            params: {
              packageRoot: params.packageRoot ?? npmRoot,
              currentVersion: params.currentVersion ?? "0.0.41",
            },
          }),
          Layer.succeed(RigUpdaterPlatformService, {
            executableExists: Effect.fn("RigUpdaterPlatformService.executableExists")(function* (
              path: string,
            ) {
              return executablePaths.has(path);
            }),
            basename: Effect.fn("RigUpdaterPlatformService.basename")(function* (path: string) {
              return path.split("/").at(-1) ?? "";
            }),
            dirname: Effect.fn("RigUpdaterPlatformService.dirname")(function* (path: string) {
              return path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";
            }),
            join: Effect.fn("RigUpdaterPlatformService.join")(function* (parts: string[]) {
              return parts.join("/").replaceAll("//", "/");
            }),
            resolve: Effect.fn("RigUpdaterPlatformService.resolve")(function* (path: string) {
              return path;
            }),
            readPackageVersion: Effect.fn("RigUpdaterPlatformService.readPackageVersion")(
              function* () {
                return params.currentVersion ?? "0.0.41";
              },
            ),
          }),
          Layer.succeed(RigUpdateCommandRunnerService, {
            read: Effect.fn("RigUpdateCommandRunnerService.read")(function* (step) {
              return yield* Effect.sync(() => {
                reads.push(step);
                return step.args.includes("--version") ? versionOutput : latestOutput;
              });
            }),
            run: Effect.fn("RigUpdateCommandRunnerService.run")(function* (step) {
              return yield* Effect.sync(() => {
                runs.push(step);
                return runOutput;
              });
            }),
          }),
        ),
      ),
    );
    const run = <Result>(
      operation: (service: RigUpdaterService["Service"]) => Effect.Effect<Result, RigUpdateError>,
    ) =>
      Effect.runPromise(
        RigUpdaterService.use(operation).pipe(
          Effect.provide(updaterLayer),
          Effect.mapError((error) => error.cause),
        ),
      );
    return {
      getCurrentVersion: () => params.currentVersion ?? "0.0.41",
      plan: () => run((service) => service.plan),
      update: (options: { plan?: RigUpdatePlan } = {}) =>
        run((service) => service.update(options.plan)),
      sync: (options: { plan: Exclude<RigUpdatePlan, { status: "skipped" }> }) =>
        run((service) => service.sync(options.plan)),
    };
  }
}

describe("RigUpdateCommandRunner", () => {
  const runnerLayer = rigUpdateCommandRunnerLayer;
  const run = (step: RigUpdateStep) =>
    Effect.runPromise(
      RigUpdateCommandRunnerService.use((service) => service.run(step)).pipe(
        Effect.provide(runnerLayer),
        Effect.mapError((error) => error.cause),
      ),
    );

  it("captures stdout and stderr for run and read operations", async () => {
    const script =
      'process.stdout.write(process.env.RIG_TEST ?? ""); process.stderr.write(process.env.EXTRA ?? "")';
    const step = {
      command: process.execPath,
      args: ["-e", script],
      env: { RIG_TEST: "inherited", EXTRA: " added" },
    };

    expect(await run(step)).toBe("inherited added");
    expect(
      await Effect.runPromise(
        RigUpdateCommandRunnerService.use((service) => service.read(step)).pipe(
          Effect.provide(runnerLayer),
          Effect.mapError((error) => error.cause),
        ),
      ),
    ).toBe("inherited added");
  });

  it("reports command output when a process exits unsuccessfully", async () => {
    await expect(
      run({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("registry failed"); process.exit(2)'],
      }),
    ).rejects.toThrow(`${process.execPath} exited with code 2.\nregistry failed`);
  });

  it("reports a terminating signal without empty output", async () => {
    await expect(run({ command: "/bin/sh", args: ["-c", "kill -TERM $$"] })).rejects.toThrow(
      "/bin/sh exited with SIGTERM.",
    );
  });

  it("forwards process spawn errors", async () => {
    await expect(run({ command: "/path/that/does/not/exist", args: [] })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an unknown exit when a process has no code or signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as RigShellChildProcess;
    const shellPlatformLayer = Layer.succeed(RigShellPlatformService, {
      environment: Effect.succeed({}),
      currentDirectory: Effect.succeed("/tmp"),
      detached: Effect.succeed(false),
      spawn: Effect.fn("RigShellPlatformService.spawn")(function* () {
        queueMicrotask(() => child.emit("close", null, null));
        return child;
      }),
    });
    const managedLayer = ManagedProcessService.layer.pipe(
      Layer.provide(ManagedProcessConfigService.layer),
    );
    const processLayer = ShellProcessService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          RigShellConfigService.layer,
          shellPlatformLayer,
          managedLayer,
          ShellOutputService.layer,
        ),
      ),
    );
    const shellLayer = RigShellService.layer.pipe(
      Layer.provide(Layer.merge(ShellTemplateService.layer, processLayer)),
    );
    const unknownExitLayer = RigUpdateCommandRunnerService.layer.pipe(Layer.provide(shellLayer));

    await expect(
      Effect.runPromise(
        RigUpdateCommandRunnerService.use((service) =>
          service.run({ command: "mystery", args: [] }),
        ).pipe(
          Effect.provide(unknownExitLayer),
          Effect.mapError((error) => error.cause),
        ),
      ),
    ).rejects.toThrow("mystery exited with code unknown.");
  });
});

describe("RigUpdater", () => {
  it("plans, installs, verifies, and synchronizes an npm update", async () => {
    const Context = new RigUpdaterTestContext();
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
    const Context = new RigUpdaterTestContext();
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
    const Context = new RigUpdaterTestContext();
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
    const Context = new RigUpdaterTestContext();

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
    const MissingPackageManager = new RigUpdaterTestContext();
    MissingPackageManager.executablePaths.delete(npmExecutable);
    await expect(MissingPackageManager.create().plan()).resolves.toEqual({
      status: "skipped",
      reason: `The package manager for this Rig installation was not found at ${npmExecutable}.`,
    });

    const MissingRig = new RigUpdaterTestContext();
    MissingRig.executablePaths.delete(rigExecutable);
    await expect(MissingRig.create().plan()).resolves.toEqual({
      status: "skipped",
      reason: `The Rig executable for this installation was not found at ${rigExecutable}.`,
    });
  });

  it("rejects empty, non-string, and malformed latest versions", async () => {
    await Promise.all(
      ['""', "42", "not-a-version"].map(async function rejectOutput(output) {
        const Context = new RigUpdaterTestContext();
        Context.latestOutput = output;
        await expect(Context.create().plan()).rejects.toThrow(
          "The package manager returned an invalid latest Rig version.",
        );
      }),
    );
  });

  it("accepts prerelease versions", async () => {
    const Context = new RigUpdaterTestContext();
    Context.latestOutput = '"0.1.0-beta.1"';

    await expect(Context.create().plan()).resolves.toMatchObject({
      status: "ready",
      latestVersion: "0.1.0-beta.1",
    });
  });

  it("rejects a mismatched or missing installed version", async () => {
    await Promise.all(
      ["0.0.43\n", "\n"].map(async function rejectVersion(versionOutput) {
        const Context = new RigUpdaterTestContext();
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
    const Context = new RigUpdaterTestContext();
    const plan: RigUpdatePlan = { status: "skipped", reason: "Development checkout." };

    await expect(Context.create().update({ plan })).resolves.toBe(plan);
    expect(Context.runs).toEqual([]);
  });
});
