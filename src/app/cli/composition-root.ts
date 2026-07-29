import { Context, Effect, Layer } from "effect";
import {
  RigPathsOptionsConfigService,
  RigPathsPlatformService,
} from "../../providers/paths/rig-paths";
import { RigError } from "../../providers/errors/rig-error";
import { CliCommandService, cliCommandLayer } from "./cli-application";
import { CliPlatformService, cliPlatformLayer } from "./cli-platform";
import { RuntimeBootstrapService, runtimeBootstrapLayer } from "./runtime-bootstrap";

export type CliCompositionRootParams = Readonly<{
  metaUrl: string;
  argv: string[];
}>;

export class CliApplicationService extends Context.Service<
  CliApplicationService,
  { readonly run: (params: CliCompositionRootParams) => Effect.Effect<void, RigError> }
>()("@rendotdev/rig/application/CliApplicationService", {
  make: Effect.gen(function* () {
    const runtimeBootstrap = yield* RuntimeBootstrapService;
    const command = yield* CliCommandService;
    const platform = yield* CliPlatformService;
    const run = Effect.fn("CliApplicationService.run")(function* (
      params: CliCompositionRootParams,
    ) {
      const bootstrapCode = yield* runtimeBootstrap.run(params);
      if (bootstrapCode !== undefined) return yield* platform.setExitCode(bootstrapCode);
      return yield* command.run(params.argv);
    });
    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliApplicationService, CliApplicationService.make);
}

const cliApplicationDependenciesLayer = Layer.mergeAll(
  runtimeBootstrapLayer,
  cliCommandLayer,
  cliPlatformLayer,
);
const cliPathEnvironmentLayer = Layer.merge(
  RigPathsOptionsConfigService.layer,
  RigPathsPlatformService.layer,
);
const cliApplicationLayer = CliApplicationService.layer.pipe(
  Layer.provide(cliApplicationDependenciesLayer),
  Layer.provide(cliPathEnvironmentLayer),
);

export const runCli = Effect.fn("CliApplicationService.runCli")(function* (
  params: CliCompositionRootParams,
) {
  const application = yield* CliApplicationService;
  yield* application.run(params);
});

export function runCliMain(params: CliCompositionRootParams): Promise<void> {
  return Effect.runPromise(runCli(params).pipe(Effect.provide(cliApplicationLayer)));
}
