import { Context, Effect, Layer } from "effect";
import { RigError } from "../../providers/errors/rig-error";
import { RigUpdaterService, rigUpdaterLayer } from "../../domains/updates/runtime/rig-updater";
import {
  type CommandUiReporter,
  CommandUiRendererService,
  commandUiRendererLayer,
} from "./command-ui";

type CliUpdateResult = Readonly<{ status: "ready" | "skipped"; currentVersion: string }>;

export class CliUpdateOperationsService extends Context.Service<
  CliUpdateOperationsService,
  { readonly update: Effect.Effect<void, unknown> }
>()("@rendotdev/rig/application/CliUpdateOperationsService", {
  make: Effect.gen(function* () {
    const updater = yield* RigUpdaterService;
    const ui = yield* CommandUiRendererService;
    const execute = Effect.fn("CliUpdateOperationsService.execute")(function* (
      report: CommandUiReporter,
    ) {
      const currentVersion = yield* updater.currentVersion;
      report.complete({ label: `Current version: ${currentVersion}` });
      report("Checking for updates");
      const plan = yield* updater.plan;
      if (plan.status === "skipped") {
        report.complete({
          label: "Update unavailable",
          detail: `  ${plan.reason}`,
          mutedDetail: true,
        });
        return { status: "skipped" as const, currentVersion };
      }
      if (plan.status === "ready") {
        report.complete({
          label: `Update available: ${plan.currentVersion} to ${plan.latestVersion}`,
        });
        report("Updating Rig");
        const result = yield* updater.update(plan);
        if (result.status !== "updated") {
          return yield* new RigError({
            code: "INTERNAL_ERROR",
            message: "Rig did not complete the planned update.",
          });
        }
        report.complete({
          label: `Updated Rig: ${result.previousVersion} to ${result.version}`,
          detail: yield* ui.formatUpdateCommandOutputGroups({
            steps: [result.step],
            outputs: [result.output],
          }),
          mutedDetail: true,
        });
      } else {
        report.complete({ label: `Already up to date: ${plan.version}` });
      }
      report("Synchronizing runtime and agent instructions");
      const sync = yield* updater.sync(plan);
      report.complete({
        label: "Synchronized runtime and agent instructions",
        detail: yield* ui.formatUpdateCommandOutputGroups({
          steps: [sync.step],
          outputs: [sync.output],
        }),
        mutedDetail: true,
      });
      return { status: "ready" as const, currentVersion };
    });
    const renderSuccess = (result: CliUpdateResult) =>
      result.status === "skipped"
        ? `Rig ${result.currentVersion} was left unchanged.`
        : "Rig is ready to use.";
    const update = ui
      .run({
        label: "Preparing Rig update",
        successLabel: "Update finished",
        execute,
        renderSuccess,
      })
      .pipe(Effect.asVoid, Effect.withSpan("CliUpdateOperationsService.update"));
    return { update } as const;
  }),
}) {
  static readonly layer = Layer.effect(CliUpdateOperationsService, CliUpdateOperationsService.make);
}

export const cliUpdateOperationsLayer = CliUpdateOperationsService.layer.pipe(
  Layer.provide(Layer.merge(rigUpdaterLayer, commandUiRendererLayer)),
);
