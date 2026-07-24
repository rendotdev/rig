import { basename } from "node:path";
import { Text, render, useAnimation, type Instance } from "ink";
import type { ReactElement } from "react";
import { defineService, defineUIComponent } from "../../define";
import type { RigUpdateStep } from "../../runtime/updates/rig-updater";
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

export const CommandUiComponent = defineUIComponent({
  params: {},
  deps: {},
  component(props: CommandUiProps) {
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
        {props.completed?.map(function renderCompleted(item, index) {
          return (
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
          );
        })}
        {hasCompleted && current ? "\n" : ""}
        {current ? <Text color={color}>{current}</Text> : null}
      </Text>
    );
  },
});

export const CommandUi = CommandUiComponent;

function createReporter(params: {
  onUpdate: (label: string) => void;
  onComplete: (item: CommandUiCompletedItem) => void;
}): CommandUiReporter {
  function report(label: string) {
    params.onUpdate(label);
  }
  const reporter = report as CommandUiReporter;
  reporter.complete = function complete(item) {
    params.onComplete(item);
  };
  return reporter;
}

function ignoreUpdate(_label: string): void {}

function formatCompleted(params: { completed: CommandUiCompletedItem[] }): string {
  return params.completed
    .map(function formatItem(item) {
      return `${TerminalIcons.success} ${item.label}${item.detail ? `\n${item.detail}` : ""}`;
    })
    .join("\n");
}

function formatUpdateCommandOutputGroups(params: {
  steps: RigUpdateStep[];
  outputs: string[];
}): string | undefined {
  const groups = params.steps.flatMap(function formatStep(step, index) {
    const output = params.outputs[index]?.trim();
    if (!output) return [];
    const command = [basename(step.command), ...step.args].join(" ");
    return [
      `  ${command}`,
      ...output.split("\n").map(function indent(line) {
        return `    ${line}`;
      }),
    ];
  });
  return groups.length > 0 ? groups.join("\n") : undefined;
}

type CommandUiRendererDeps = {
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  render: (
    tree: ReactElement,
    options: { stdout: NodeJS.WriteStream; patchConsole: boolean },
  ) => Pick<Instance, "rerender" | "unmount" | "waitUntilRenderFlush">;
};

const CommandUiRendererProductionDeps: CommandUiRendererDeps = {
  stdout: process.stdout,
  render,
};

export class CommandUiRendererService extends defineService({
  params: {},
  deps: CommandUiRendererProductionDeps,
}) {
  public async run<Result>(params: {
    label: string;
    successLabel?: string;
    execute: (report: CommandUiReporter) => Promise<Result>;
    renderSuccess: (result: Result) => string;
  }): Promise<Result> {
    const successLabel = params.successLabel ?? params.label;
    const completed: CommandUiCompletedItem[] = [];
    if (!this.deps.stdout.isTTY) {
      const reporter = createReporter({
        onUpdate: ignoreUpdate,
        onComplete: function captureCompleted(item) {
          completed.push(item);
        },
      });
      const result = await params.execute(reporter);
      const detail = params.renderSuccess(result);
      const output = [
        formatCompleted({ completed }),
        `${TerminalIcons.success} ${successLabel}`,
        detail,
      ]
        .filter(Boolean)
        .join("\n");
      this.deps.stdout.write(`${output}\n`);
      return result;
    }

    const instance = this.deps.render(<CommandUiComponent state="loading" label={params.label} />, {
      stdout: this.deps.stdout as NodeJS.WriteStream,
      patchConsole: false,
    });
    let currentLabel = params.label;
    function report(label: string) {
      currentLabel = label;
      instance.rerender(<CommandUiComponent state="loading" label={label} completed={completed} />);
    }
    const reporter = createReporter({
      onUpdate: report,
      onComplete: function complete(item) {
        completed.push(item);
        currentLabel = "";
        instance.rerender(<CommandUiComponent state="loading" label="" completed={completed} />);
      },
    });

    try {
      const result = await params.execute(reporter);
      instance.rerender(
        <CommandUiComponent
          state="success"
          label={successLabel}
          detail={params.renderSuccess(result)}
          completed={completed}
        />,
      );
      await instance.waitUntilRenderFlush();
      instance.unmount();
      return result;
    } catch (error) {
      instance.rerender(
        <CommandUiComponent
          state="error"
          label={currentLabel || params.label}
          detail={error instanceof Error ? error.message : String(error)}
          completed={completed}
        />,
      );
      await instance.waitUntilRenderFlush();
      instance.unmount();
      throw error;
    }
  }

  public formatCommandOutputGroups(params: { steps: RigUpdateStep[]; outputs: string[] }) {
    return formatUpdateCommandOutputGroups(params);
  }
}

export const CommandUiRenderer = new CommandUiRendererService();

export type CommandUiRendererClass = {
  run: typeof CommandUiRenderer.run;
  formatCommandOutputGroups: typeof CommandUiRenderer.formatCommandOutputGroups;
};

type CommandUiRendererConstructor = {
  new (params: {}, deps: CommandUiRendererDeps): CommandUiRendererClass;
  readonly prototype: CommandUiRendererClass;
};

type CommandUiRendererAdapter = CommandUiRendererClass & {
  readonly resource: CommandUiRendererService;
};

const CommandUiRendererClassAdapter = function constructCommandUiRenderer(
  this: CommandUiRendererAdapter,
  _params: {},
  deps: CommandUiRendererDeps,
): void {
  Object.defineProperty(this, "resource", {
    value: new CommandUiRendererService({ params: {}, deps }),
  });
};
Object.defineProperty(CommandUiRendererClassAdapter, "name", {
  value: "CommandUiRendererClass",
});
Object.defineProperties(CommandUiRendererClassAdapter.prototype, {
  run: {
    configurable: true,
    value: function run<Result>(
      this: CommandUiRendererAdapter,
      params: {
        label: string;
        successLabel?: string;
        execute: (report: CommandUiReporter) => Promise<Result>;
        renderSuccess: (result: Result) => string;
      },
    ) {
      return this.resource.run(params);
    },
    writable: true,
  },
  formatCommandOutputGroups: {
    configurable: true,
    value: function formatCommandOutputGroups(
      this: CommandUiRendererAdapter,
      params: { steps: RigUpdateStep[]; outputs: string[] },
    ) {
      return this.resource.formatCommandOutputGroups(params);
    },
    writable: true,
  },
});

export const CommandUiRendererClass =
  CommandUiRendererClassAdapter as unknown as CommandUiRendererConstructor;
