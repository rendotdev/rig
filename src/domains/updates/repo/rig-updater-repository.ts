import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  basename as pathBasename,
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ManagedProcessError } from "../../../providers/process/managed-process";
import { RigShellService, rigShellLayer } from "../../../providers/process/rig-shell-service";
import { RigPackageManifest, RigUpdateError, type RigUpdateStep } from "../types/updates";

export class RigUpdateCommandRunnerService extends Context.Service<
  RigUpdateCommandRunnerService,
  {
    readonly run: (step: RigUpdateStep) => Effect.Effect<string, RigUpdateError>;
    readonly read: (step: RigUpdateStep) => Effect.Effect<string, RigUpdateError>;
  }
>()("@rendotdev/rig/updates/RigUpdateCommandRunnerService", {
  make: Effect.gen(function* () {
    const shell = yield* RigShellService;
    const execute = Effect.fn("RigUpdateCommandRunnerService.execute")(function* (
      step: RigUpdateStep,
    ) {
      const result = yield* shell.exec([step.command, ...step.args], { env: step.env }).pipe(
        Effect.mapError(
          (error) =>
            new RigUpdateError({
              operation: "command",
              cause: error.cause instanceof ManagedProcessError ? error.cause.cause : error.cause,
            }),
        ),
      );
      if (result.exitCode !== 0) {
        const detail = `${result.stdout}${result.stderr}`.trim();
        return yield* new RigUpdateError({
          operation: "command",
          cause: new Error(
            `${step.command} exited with ${result.signal ?? (result.exitCodeKnown ? `code ${result.exitCode}` : "code unknown")}.${detail ? `\n${detail}` : ""}`,
          ),
        });
      }
      return `${result.stdout}${result.stderr}`;
    });
    const run = Effect.fn("RigUpdateCommandRunnerService.run")(function* (step: RigUpdateStep) {
      return yield* execute(step);
    });
    const read = Effect.fn("RigUpdateCommandRunnerService.read")(function* (step: RigUpdateStep) {
      return yield* execute(step);
    });
    return { run, read } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    RigUpdateCommandRunnerService,
    RigUpdateCommandRunnerService.make,
  );
}

export const rigUpdateCommandRunnerLayer = RigUpdateCommandRunnerService.layer.pipe(
  Layer.provide(rigShellLayer),
);

export class RigUpdaterPlatformService extends Context.Service<
  RigUpdaterPlatformService,
  {
    readonly executableExists: (path: string) => Effect.Effect<boolean>;
    readonly basename: (path: string) => Effect.Effect<string>;
    readonly dirname: (path: string) => Effect.Effect<string>;
    readonly join: (parts: string[]) => Effect.Effect<string>;
    readonly resolve: (path: string) => Effect.Effect<string>;
    readonly readPackageVersion: (path: string) => Effect.Effect<string, RigUpdateError>;
  }
>()("@rendotdev/rig/updates/RigUpdaterPlatformService", {
  make: Effect.gen(function* () {
    const executableExists = Effect.fn("RigUpdaterPlatformService.executableExists")(function* (
      path: string,
    ) {
      return existsSync(path);
    });
    const basename = Effect.fn("RigUpdaterPlatformService.basename")(function* (path: string) {
      return pathBasename(path);
    });
    const dirname = Effect.fn("RigUpdaterPlatformService.dirname")(function* (path: string) {
      return pathDirname(path);
    });
    const join = Effect.fn("RigUpdaterPlatformService.join")(function* (parts: string[]) {
      return pathJoin(...parts);
    });
    const resolve = Effect.fn("RigUpdaterPlatformService.resolve")(function* (path: string) {
      return pathResolve(path);
    });
    const readPackageVersion = Effect.fn("RigUpdaterPlatformService.readPackageVersion")(function* (
      path: string,
    ) {
      const value = yield* Effect.tryPromise({
        try: async () =>
          typeof Bun !== "undefined" && typeof Bun.file === "function"
            ? await Bun.file(path).json()
            : JSON.parse(await readFile(path, "utf8")),
        catch: (cause) => new RigUpdateError({ operation: "plan", cause }),
      });
      const manifest = yield* Schema.decodeUnknownEffect(RigPackageManifest)(value).pipe(
        Effect.mapError((cause) => new RigUpdateError({ operation: "plan", cause })),
      );
      return manifest.version;
    });
    return { executableExists, basename, dirname, join, resolve, readPackageVersion } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigUpdaterPlatformService, RigUpdaterPlatformService.make);
}

export const rigUpdaterRepositoryLayer = RigUpdaterPlatformService.layer;
