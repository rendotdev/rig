import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import type { CronAddOptions } from "../../domains/scheduling/types/cron";
import { RigCronService, rigCronLayer } from "../../domains/scheduling/runtime/rig-cron";
import { DevLinkService, devLinkLayer } from "../../domains/updates/runtime/dev-link";
import { CliEnvironmentConfigService, CliPlatformService, cliPlatformLayer } from "./cli-platform";

export type CliCronAddOptions = Readonly<
  Omit<CronAddOptions, "name" | "command" | "schedule" | "moduleUrl">
>;

export class CliCronOperationsService extends Context.Service<
  CliCronOperationsService,
  {
    readonly list: Effect.Effect<void, unknown>;
    readonly add: (
      name: string,
      command: string,
      schedule: string,
      options: CliCronAddOptions,
    ) => Effect.Effect<void, unknown>;
    readonly remove: (name: string) => Effect.Effect<void, unknown>;
    readonly run: (name: string) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliCronOperationsService", {
  make: Effect.gen(function* () {
    const cron = yield* RigCronService;
    const platform = yield* CliPlatformService;
    const environment = yield* CliEnvironmentConfigService;
    const moduleUrl = pathToFileURL(environment.argv[1] ?? fileURLToPath(import.meta.url)).href;
    const list = cron.list.pipe(
      Effect.flatMap(platform.printJson),
      Effect.withSpan("CliCronOperationsService.list"),
    );
    const add = Effect.fn("CliCronOperationsService.add")(function* (
      name: string,
      command: string,
      schedule: string,
      options: CliCronAddOptions,
    ) {
      yield* platform.printJson(
        yield* cron.add({ name, command, schedule, ...options, moduleUrl }),
      );
    });
    const remove = Effect.fn("CliCronOperationsService.remove")(function* (name: string) {
      yield* platform.printJson(yield* cron.remove(name));
    });
    const run = Effect.fn("CliCronOperationsService.run")(function* (name: string) {
      const result = yield* cron.run(name);
      yield* platform.printJson(result.envelope);
      yield* platform.setExitCode(result.exitCode);
    });
    return { list, add, remove, run } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliCronOperationsService, CliCronOperationsService.make);
}

export class CliDevOperationsService extends Context.Service<
  CliDevOperationsService,
  {
    readonly link: (options: { binDir?: string; force?: boolean }) => Effect.Effect<void, unknown>;
    readonly unlink: (options: {
      binDir?: string;
      force?: boolean;
    }) => Effect.Effect<void, unknown>;
    readonly status: (options: { binDir?: string }) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliDevOperationsService", {
  make: Effect.gen(function* () {
    const devLink = yield* DevLinkService;
    const platform = yield* CliPlatformService;
    const link = Effect.fn("CliDevOperationsService.link")(function* (options: {
      binDir?: string;
      force?: boolean;
    }) {
      yield* platform.log(yield* devLink.renderLink(yield* devLink.link(options)));
    });
    const unlink = Effect.fn("CliDevOperationsService.unlink")(function* (options: {
      binDir?: string;
      force?: boolean;
    }) {
      yield* platform.log(yield* devLink.renderUnlink(yield* devLink.unlink(options)));
    });
    const status = Effect.fn("CliDevOperationsService.status")(function* (options: {
      binDir?: string;
    }) {
      yield* platform.printJson(yield* devLink.status(options));
    });
    return { link, unlink, status } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliDevOperationsService, CliDevOperationsService.make);
}

export const cliCronOperationsLayer = CliCronOperationsService.layer.pipe(
  Layer.provide(Layer.mergeAll(rigCronLayer, cliPlatformLayer, CliEnvironmentConfigService.layer)),
);
export const cliDevOperationsLayer = CliDevOperationsService.layer.pipe(
  Layer.provide(Layer.merge(devLinkLayer, cliPlatformLayer)),
);
