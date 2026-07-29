import { basename } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { Text, render as renderInk, useAnimation, type Instance } from "ink";
import type { ReactElement } from "react";
import type { RigUpdateStep } from "../../domains/updates/types/updates";
import { TerminalColors, TerminalIcons } from "./terminal-theme";

type CommandUiState = "loading" | "success" | "error";
type CommandUiCompletedItem = { label: string; detail?: string; mutedDetail?: boolean };

export type CommandUiReporter = ((label: string) => void) & {
  complete: (params: CommandUiCompletedItem) => void;
};

type CommandUiProps = {
  state: CommandUiState;
  label: string;
  detail?: string;
  completed?: CommandUiCompletedItem[];
};

export function CommandUiComponent(props: CommandUiProps) {
  const { frame } = useAnimation({ interval: 80, isActive: props.state === "loading" });
  const symbol =
    props.state === "loading"
      ? TerminalIcons.loading({ frame })
      : props.state === "success"
        ? TerminalIcons.success
        : TerminalIcons.error;
  const color =
    props.state === "success"
      ? TerminalColors.success
      : props.state === "error"
        ? TerminalColors.error
        : TerminalColors.loading;
  const hasCompleted = Boolean(props.completed?.length);
  const current = props.label
    ? `${symbol} ${props.label}${props.detail ? `\n${props.detail}` : ""}`
    : "";

  return (
    <Text>
      {props.completed?.map((item, index) => (
        <Text key={`${index}-${item.label}`}>
          {index > 0 ? "\n" : ""}
          <Text color={TerminalColors.success}>
            {TerminalIcons.success} {item.label}
          </Text>
          {item.detail ? (
            <Text color={item.mutedDetail ? TerminalColors.muted : TerminalColors.success}>
              {`\n${item.detail}`}
            </Text>
          ) : null}
        </Text>
      ))}
      {hasCompleted && current ? "\n" : ""}
      {current ? <Text color={color}>{current}</Text> : null}
    </Text>
  );
}

type CommandUiInstance = Pick<Instance, "rerender" | "unmount" | "waitUntilRenderFlush">;

export class CommandUiError extends Schema.TaggedErrorClass<CommandUiError>()("CommandUiError", {
  cause: Schema.Defect(),
}) {}

export type CommandUiRunOptions<Result, Error = never> = {
  label: string;
  successLabel?: string;
  execute: (report: CommandUiReporter) => Effect.Effect<Result, Error>;
  renderSuccess: (result: Result) => string;
};

export class CommandUiPlatformService extends Context.Service<
  CommandUiPlatformService,
  {
    readonly isInteractive: Effect.Effect<boolean>;
    readonly write: (value: string) => Effect.Effect<void, CommandUiError>;
    readonly render: (tree: ReactElement) => Effect.Effect<CommandUiInstance, CommandUiError>;
  }
>()("@rendotdev/rig/application/CommandUiPlatformService", {
  make: Effect.gen(function* () {
    const isInteractive = Effect.sync(() => Boolean(process.stdout.isTTY)).pipe(
      Effect.withSpan("CommandUiPlatformService.isInteractive"),
    );
    const write = Effect.fn("CommandUiPlatformService.write")(function* (value: string) {
      yield* Effect.try({
        try: () => {
          process.stdout.write(value);
        },
        catch: (cause) => new CommandUiError({ cause }),
      });
    });
    const render = Effect.fn("CommandUiPlatformService.render")(function* (tree: ReactElement) {
      return yield* Effect.try({
        try: () => renderInk(tree, { stdout: process.stdout, patchConsole: false }),
        catch: (cause) => new CommandUiError({ cause }),
      });
    });
    return { isInteractive, write, render } as const;
  }),
}) {
  static readonly layer = Layer.effect(CommandUiPlatformService, CommandUiPlatformService.make);
}

export class CommandUiNonInteractiveService extends Context.Service<
  CommandUiNonInteractiveService,
  {
    readonly run: <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) => Effect.Effect<Result, CommandUiError | Error>;
  }
>()("@rendotdev/rig/application/CommandUiNonInteractiveService", {
  make: Effect.gen(function* () {
    const platform = yield* CommandUiPlatformService;
    const createReporter = (params: {
      onUpdate: (label: string) => void;
      onComplete: (item: CommandUiCompletedItem) => void;
    }): CommandUiReporter => {
      const report = ((label: string) => params.onUpdate(label)) as CommandUiReporter;
      report.complete = (item) => params.onComplete(item);
      return report;
    };

    const formatCompleted = (completed: CommandUiCompletedItem[]) =>
      completed
        .map(
          (item) =>
            `${TerminalIcons.success} ${item.label}${item.detail ? `\n${item.detail}` : ""}`,
        )
        .join("\n");

    const run = Effect.fn("CommandUiNonInteractiveService.run")(function* <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) {
      const completed: CommandUiCompletedItem[] = [];
      const reporter = createReporter({
        onUpdate: () => undefined,
        onComplete: (item) => completed.push(item),
      });
      const result = yield* params.execute(reporter);
      const output = [
        formatCompleted(completed),
        `${TerminalIcons.success} ${params.successLabel ?? params.label}`,
        params.renderSuccess(result),
      ]
        .filter(Boolean)
        .join("\n");
      yield* platform.write(`${output}\n`);
      return result;
    });

    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CommandUiNonInteractiveService,
    CommandUiNonInteractiveService.make,
  );
}

export class CommandUiInteractiveService extends Context.Service<
  CommandUiInteractiveService,
  {
    readonly run: <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) => Effect.Effect<Result, CommandUiError | Error>;
  }
>()("@rendotdev/rig/application/CommandUiInteractiveService", {
  make: Effect.gen(function* () {
    const platform = yield* CommandUiPlatformService;
    const createReporter = (params: {
      onUpdate: (label: string) => void;
      onComplete: (item: CommandUiCompletedItem) => void;
    }): CommandUiReporter => {
      const report = ((label: string) => params.onUpdate(label)) as CommandUiReporter;
      report.complete = (item) => params.onComplete(item);
      return report;
    };

    const run = Effect.fn("CommandUiInteractiveService.run")(function* <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) {
      const completed: CommandUiCompletedItem[] = [];
      const instance = yield* platform.render(
        <CommandUiComponent state="loading" label={params.label} />,
      );
      let currentLabel = params.label;
      const reporter = createReporter({
        onUpdate: (label) => {
          currentLabel = label;
          instance.rerender(
            <CommandUiComponent state="loading" label={label} completed={completed} />,
          );
        },
        onComplete: (item) => {
          completed.push(item);
          currentLabel = "";
          instance.rerender(<CommandUiComponent state="loading" label="" completed={completed} />);
        },
      });
      return yield* params.execute(reporter).pipe(
        Effect.tap((result) =>
          Effect.tryPromise({
            try: async () => {
              instance.rerender(
                <CommandUiComponent
                  state="success"
                  label={params.successLabel ?? params.label}
                  detail={params.renderSuccess(result)}
                  completed={completed}
                />,
              );
              await instance.waitUntilRenderFlush();
            },
            catch: (cause) => new CommandUiError({ cause }),
          }),
        ),
        Effect.tapError((error) =>
          Effect.tryPromise({
            try: async () => {
              instance.rerender(
                <CommandUiComponent
                  state="error"
                  label={currentLabel || params.label}
                  detail={
                    error instanceof CommandUiError
                      ? error.cause instanceof Error
                        ? error.cause.message
                        : String(error.cause)
                      : error instanceof Error
                        ? error.message
                        : String(error)
                  }
                  completed={completed}
                />,
              );
              await instance.waitUntilRenderFlush();
            },
            catch: (cause) => new CommandUiError({ cause }),
          }),
        ),
        Effect.ensuring(Effect.sync(() => instance.unmount())),
      );
    });

    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CommandUiInteractiveService,
    CommandUiInteractiveService.make,
  );
}

export class CommandUiRendererService extends Context.Service<
  CommandUiRendererService,
  {
    readonly run: <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) => Effect.Effect<Result, CommandUiError | Error>;
    readonly formatUpdateCommandOutputGroups: (params: {
      steps: RigUpdateStep[];
      outputs: string[];
    }) => Effect.Effect<string | undefined>;
  }
>()("@rendotdev/rig/application/CommandUiRendererService", {
  make: Effect.gen(function* () {
    const platform = yield* CommandUiPlatformService;
    const interactive = yield* CommandUiInteractiveService;
    const nonInteractive = yield* CommandUiNonInteractiveService;

    const renderUpdateOutput = (params: {
      steps: RigUpdateStep[];
      outputs: string[];
    }): string | undefined => {
      const groups = params.steps.flatMap((step, index) => {
        const output = params.outputs[index]?.trim();
        if (!output) return [];
        const command = [basename(step.command), ...step.args].join(" ");
        return [`  ${command}`, ...output.split("\n").map((line) => `    ${line}`)];
      });
      return groups.length > 0 ? groups.join("\n") : undefined;
    };

    const formatUpdateCommandOutputGroups = Effect.fn(
      "CommandUiRendererService.formatUpdateCommandOutputGroups",
    )(function* (params: { steps: RigUpdateStep[]; outputs: string[] }) {
      return renderUpdateOutput(params);
    });

    const run = Effect.fn("CommandUiRendererService.run")(function* <Result, Error>(
      params: CommandUiRunOptions<Result, Error>,
    ) {
      return (yield* platform.isInteractive)
        ? yield* interactive.run(params)
        : yield* nonInteractive.run(params);
    });

    return { run, formatUpdateCommandOutputGroups } as const;
  }),
}) {
  static readonly layer = Layer.effect(CommandUiRendererService, CommandUiRendererService.make);
}

const commandUiExecutionLayer = Layer.merge(
  CommandUiInteractiveService.layer,
  CommandUiNonInteractiveService.layer,
).pipe(Layer.provide(CommandUiPlatformService.layer));

export const commandUiRendererLayer = CommandUiRendererService.layer.pipe(
  Layer.provide(Layer.merge(CommandUiPlatformService.layer, commandUiExecutionLayer)),
);
