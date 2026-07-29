import { Cause, Context, Effect, Layer } from "effect";
import { RigError } from "../../providers/errors/rig-error";
import {
  type CliCommandController,
  cliCommandRegistrationLayer,
  CliCronCommandRegistrationService,
  CliDevCommandRegistrationService,
  CliGeneralCommandRegistrationService,
  CliToolExecutionCommandRegistrationService,
  CliToolReadCommandRegistrationService,
  CliToolWriteCommandRegistrationService,
} from "./cli-command-registration";
import { CliGeneralOperationsService, cliGeneralOperationsLayer } from "./cli-general-operations";
import { CliPlatformService, cliPlatformLayer } from "./cli-platform";

export class CliCommandService extends Context.Service<
  CliCommandService,
  { readonly run: (argv: string[]) => Effect.Effect<void> }
>()("@rendotdev/rig/application/CliCommandService", {
  make: Effect.gen(function* () {
    const general = yield* CliGeneralOperationsService;
    const generalRegistration = yield* CliGeneralCommandRegistrationService;
    const toolReadRegistration = yield* CliToolReadCommandRegistrationService;
    const toolWriteRegistration = yield* CliToolWriteCommandRegistrationService;
    const toolExecutionRegistration = yield* CliToolExecutionCommandRegistrationService;
    const cronRegistration = yield* CliCronCommandRegistrationService;
    const devRegistration = yield* CliDevCommandRegistrationService;
    const platform = yield* CliPlatformService;
    const normalizeError = (cause: unknown): RigError => {
      if (cause instanceof RigError) return cause;
      return new RigError({
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    };
    const execute = Effect.fn("CliCommandService.execute")(function* (argv: string[]) {
      const program = new (yield* Effect.tryPromise({
        try: () => import("commander"),
        catch: normalizeError,
      })).Command();
      let pending: Effect.Effect<void, unknown> | undefined;
      let generatedSyncRequested = false;
      const controller: CliCommandController = {
        schedule: (effect, sync = false) => {
          pending = effect;
          generatedSyncRequested ||= sync;
        },
      };
      program
        .name("rig")
        .description("Local typed command runtime for agents.")
        .version(yield* general.version)
        .addHelpCommand(false);
      yield* generalRegistration.configure(program, controller);
      yield* toolReadRegistration.configure(program, controller);
      yield* toolWriteRegistration.configure(program, controller);
      yield* toolExecutionRegistration.configure(program, controller);
      yield* cronRegistration.configure(program, controller);
      yield* devRegistration.configure(program, controller);
      if (argv.slice(2).length === 0) controller.schedule(general.defaultStatus, true);
      else yield* Effect.tryPromise({ try: () => program.parseAsync(argv), catch: normalizeError });
      if (pending) yield* pending;
      if (generatedSyncRequested) yield* general.syncGeneratedFiles;
    });
    const run = Effect.fn("CliCommandService.run")(function* (argv: string[]) {
      return yield* execute(argv).pipe(
        Effect.catchCause((cause) => platform.fail(Cause.squash(cause))),
      );
    });
    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliCommandService, CliCommandService.make);
}

export const cliCommandLayer = CliCommandService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(cliCommandRegistrationLayer, cliGeneralOperationsLayer, cliPlatformLayer),
  ),
);
