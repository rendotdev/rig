import { basename } from "node:path";
import { Text, render, useAnimation, type Instance } from "ink";
import type { ReactElement } from "react";
import { DomainClass } from "../../domain/domain-class";
import type { RigUpdateStep } from "../../runtime/updates/rig-updater";
import { TerminalColors, TerminalIcons } from "./terminal-theme";

type CommandUiState = "loading" | "success" | "error";
type CommandUiCompletedItem = { label: string; detail?: string; mutedDetail?: boolean };

export type CommandUiReporter = ((label: string) => void) & {
  complete: (params: CommandUiCompletedItem) => void;
};

export function CommandUi(props: {
  state: CommandUiState;
  label: string;
  detail?: string;
  completed?: CommandUiCompletedItem[];
}) {
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
}

export class CommandUiRendererClass extends DomainClass<
  {},
  {
    stdout: Pick<NodeJS.WriteStream, "isTTY" | "write">;
    render: (
      tree: ReactElement,
      options: { stdout: NodeJS.WriteStream; patchConsole: boolean },
    ) => Pick<Instance, "rerender" | "unmount" | "waitUntilRenderFlush">;
  }
> {
  public async run<Result>(params: {
    label: string;
    successLabel?: string;
    execute: (report: CommandUiReporter) => Promise<Result>;
    renderSuccess: (result: Result) => string;
  }): Promise<Result> {
    const successLabel = params.successLabel ?? params.label;
    const completed: CommandUiCompletedItem[] = [];
    if (!this.deps.stdout.isTTY) {
      const reporter = this.createReporter({
        onUpdate: this.ignoreUpdate.bind(this),
        onComplete: function captureCompleted(item) {
          completed.push(item);
        },
      });
      const result = await params.execute(reporter);
      const detail = params.renderSuccess(result);
      const output = [
        this.formatCompleted({ completed }),
        `${TerminalIcons.success} ${successLabel}`,
        detail,
      ]
        .filter(Boolean)
        .join("\n");
      this.deps.stdout.write(`${output}\n`);
      return result;
    }

    const instance = this.deps.render(<CommandUi state="loading" label={params.label} />, {
      stdout: this.deps.stdout as NodeJS.WriteStream,
      patchConsole: false,
    });
    let currentLabel = params.label;
    function report(label: string) {
      currentLabel = label;
      instance.rerender(<CommandUi state="loading" label={label} completed={completed} />);
    }
    const reporter = this.createReporter({
      onUpdate: report,
      onComplete: function complete(item) {
        completed.push(item);
        currentLabel = "";
        instance.rerender(<CommandUi state="loading" label="" completed={completed} />);
      },
    });

    try {
      const result = await params.execute(reporter);
      instance.rerender(
        <CommandUi
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
        <CommandUi
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

  public formatCommandOutputGroups(params: {
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

  private createReporter(params: {
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

  private ignoreUpdate(_label: string): void {}

  private formatCompleted(params: { completed: CommandUiCompletedItem[] }): string {
    return params.completed
      .map(function formatItem(item) {
        return `${TerminalIcons.success} ${item.label}${item.detail ? `\n${item.detail}` : ""}`;
      })
      .join("\n");
  }
}

export const CommandUiRenderer = new CommandUiRendererClass({}, { stdout: process.stdout, render });
