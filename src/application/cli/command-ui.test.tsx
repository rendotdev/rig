import { cleanup, render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CommandUi, CommandUiRendererClass } from "./command-ui";

afterEach(cleanup);

class CommandUiTestRendererClass {
  public current?: ReactElement;
  public readonly states: ReactElement[] = [];
  public unmounted = false;
  public flushed = false;

  public render(tree: ReactElement) {
    this.capture(tree);
    return {
      rerender: (nextTree: ReactElement) => this.capture(nextTree),
      unmount: () => {
        this.unmounted = true;
      },
      waitUntilRenderFlush: async () => {
        this.flushed = true;
      },
    };
  }

  public lastFrame(): string | undefined {
    const frame = this.current ? render(this.current).lastFrame() : undefined;
    return frame ? stripVTControlCharacters(frame) : undefined;
  }

  private capture(tree: ReactElement): void {
    this.current = tree;
    this.states.push(tree);
  }
}

describe("CommandUi", () => {
  it("renders loading, success, and error states", () => {
    const view = render(<CommandUi state="loading" label="Updating Rig" />);
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe("⠋ Updating Rig");

    view.rerender(<CommandUi state="success" label="Updated Rig" detail="Rig is ready." />);
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe("✔ Updated Rig\nRig is ready.");

    view.rerender(<CommandUi state="error" label="Updating Rig" detail="Registry failed." />);
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe(
      "✖ Updating Rig\nRegistry failed.",
    );
  });

  it("renders completed items and hides an empty current state", () => {
    const view = render(
      <CommandUi
        state="loading"
        label=""
        completed={[
          { label: "Checked version" },
          { label: "Updated Rig", detail: "  npm install", mutedDetail: true },
          { label: "Synchronized", detail: "Done" },
        ]}
      />,
    );

    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe(
      "✔ Checked version\n✔ Updated Rig\n  npm install\n✔ Synchronized\nDone",
    );
  });
});

describe("CommandUiRendererClass", () => {
  it("prints one stable non-interactive result with completed details", async () => {
    const writes: string[] = [];
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: {
          isTTY: false,
          write(value) {
            writes.push(String(value));
            return true;
          },
        },
        render() {
          throw new Error("Non-interactive output must not mount Ink.");
        },
      },
    );

    const result = await Renderer.run({
      label: "Preparing Rig update",
      successLabel: "Update finished",
      async execute(report) {
        report("Checking for updates");
        report.complete({ label: "Current version: 0.0.41" });
        report.complete({
          label: "Updated Rig",
          detail: "  npm install\n    changed 1 package",
          mutedDetail: true,
        });
        return "ready";
      },
      renderSuccess(value) {
        return value === "ready" ? "Rig is ready." : "";
      },
    });

    expect(result).toBe("ready");
    expect(writes).toEqual([
      [
        "✔ Current version: 0.0.41",
        "✔ Updated Rig",
        "  npm install",
        "    changed 1 package",
        "✔ Update finished",
        "Rig is ready.",
        "",
      ].join("\n"),
    ]);
  });

  it("uses the initial label and omits an empty success detail", async () => {
    const writes: string[] = [];
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: {
          isTTY: false,
          write(value) {
            writes.push(String(value));
            return true;
          },
        },
        render() {
          throw new Error("Non-interactive output must not mount Ink.");
        },
      },
    );

    await Renderer.run({
      label: "Checking Rig",
      async execute() {
        return undefined;
      },
      renderSuccess() {
        return "";
      },
    });

    expect(writes).toEqual(["✔ Checking Rig\n"]);
  });

  it("renders interactive progress and success", async () => {
    const TestRenderer = new CommandUiTestRendererClass();
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: { isTTY: true, write: () => true },
        render: TestRenderer.render.bind(TestRenderer),
      },
    );

    const result = await Renderer.run({
      label: "Preparing Rig update",
      successLabel: "Update finished",
      async execute(report) {
        report("Checking for updates");
        report.complete({ label: "Checked for updates" });
        return 42;
      },
      renderSuccess(value) {
        return `Result: ${value}`;
      },
    });

    expect(result).toBe(42);
    expect(TestRenderer.states).toHaveLength(4);
    expect(TestRenderer.lastFrame()).toBe("✔ Checked for updates\n✔ Update finished\nResult: 42");
    expect(TestRenderer.flushed).toBe(true);
    expect(TestRenderer.unmounted).toBe(true);
  });

  it("renders Error failures against the active label", async () => {
    const TestRenderer = new CommandUiTestRendererClass();
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: { isTTY: true, write: () => true },
        render: TestRenderer.render.bind(TestRenderer),
      },
    );

    await expect(
      Renderer.run({
        label: "Preparing Rig update",
        async execute(report) {
          report("Updating Rig");
          throw new Error("Registry unavailable");
        },
        renderSuccess() {
          return "unreachable";
        },
      }),
    ).rejects.toThrow("Registry unavailable");

    expect(TestRenderer.lastFrame()).toBe("✖ Updating Rig\nRegistry unavailable");
    expect(TestRenderer.unmounted).toBe(true);
  });

  it("renders non-Error failures against the initial label after completion", async () => {
    const TestRenderer = new CommandUiTestRendererClass();
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: { isTTY: true, write: () => true },
        render: TestRenderer.render.bind(TestRenderer),
      },
    );

    await expect(
      Renderer.run({
        label: "Preparing Rig update",
        async execute(report) {
          report.complete({ label: "Checked version" });
          throw "offline";
        },
        renderSuccess() {
          return "unreachable";
        },
      }),
    ).rejects.toBe("offline");

    expect(TestRenderer.lastFrame()).toBe("✔ Checked version\n✖ Preparing Rig update\noffline");
  });

  it("formats subprocess output and omits empty groups", () => {
    const Renderer = new CommandUiRendererClass(
      {},
      {
        stdout: process.stdout,
        render() {
          throw new Error("Unexpected render.");
        },
      },
    );

    expect(
      Renderer.formatCommandOutputGroups({
        steps: [
          { command: "/runtime/bin/npm", args: ["install", "@rendotdev/rig"] },
          { command: "/runtime/bin/rig", args: ["init"] },
        ],
        outputs: ["changed 1 package\nready\n", ""],
      }),
    ).toBe("  npm install @rendotdev/rig\n    changed 1 package\n    ready");
    expect(
      Renderer.formatCommandOutputGroups({
        steps: [{ command: "rig", args: ["init"] }],
        outputs: [],
      }),
    ).toBeUndefined();
  });
});
