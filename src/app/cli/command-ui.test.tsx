import { cleanup, render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import { Effect, Layer } from "effect";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RigError } from "../../providers/errors/rig-error";
import {
  CommandUiComponent,
  CommandUiInteractiveService,
  CommandUiNonInteractiveService,
  CommandUiPlatformService,
  CommandUiRendererService,
  commandUiRendererLayer,
  type CommandUiRunOptions,
} from "./command-ui";

afterEach(cleanup);

type RendererDependencies = Readonly<{
  isInteractive: boolean;
  write: (value: string) => void;
  render: (tree: ReactElement) => {
    rerender: (tree: ReactElement) => void;
    unmount: () => void;
    waitUntilRenderFlush: () => Promise<void>;
  };
}>;

const rendererLayer = (dependencies: RendererDependencies) => {
  const platformLayer = Layer.succeed(CommandUiPlatformService, {
    isInteractive: Effect.succeed(dependencies.isInteractive),
    write: Effect.fn("CommandUiPlatformService.write")(function* (value) {
      dependencies.write(value);
    }),
    render: Effect.fn("CommandUiPlatformService.render")(function* (tree) {
      return dependencies.render(tree);
    }),
  });
  const executionLayer = Layer.merge(
    CommandUiInteractiveService.layer,
    CommandUiNonInteractiveService.layer,
  ).pipe(Layer.provide(platformLayer));
  return CommandUiRendererService.layer.pipe(
    Layer.provide(Layer.merge(platformLayer, executionLayer)),
  );
};

const runRenderer = <Result,>(
  dependencies: RendererDependencies,
  params: CommandUiRunOptions<Result, unknown>,
) =>
  Effect.runPromise(
    CommandUiRendererService.use((service) => service.run(params)).pipe(
      Effect.provide(rendererLayer(dependencies)),
    ),
  );

class CommandUiTestRenderer {
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

describe("CommandUiComponent", () => {
  it("renders loading, success, and error states", () => {
    const view = render(<CommandUiComponent state="loading" label="Updating Rig" />);
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe("⠋ Updating Rig");

    view.rerender(
      <CommandUiComponent state="success" label="Updated Rig" detail="Rig is ready." />,
    );
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe("✔ Updated Rig\nRig is ready.");

    view.rerender(
      <CommandUiComponent state="error" label="Updating Rig" detail="Registry failed." />,
    );
    expect(stripVTControlCharacters(view.lastFrame() ?? "")).toBe(
      "✖ Updating Rig\nRegistry failed.",
    );
  });

  it("renders completed items and hides an empty current state", () => {
    const view = render(
      <CommandUiComponent
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

describe("CommandUiRenderer", () => {
  it("prints one stable non-interactive result with completed details", async () => {
    const writes: string[] = [];
    const dependencies = {
      isInteractive: false,
      write(value: string) {
        writes.push(String(value));
      },
      render() {
        throw new Error("Non-interactive output must not mount Ink.");
      },
    };

    const result = await runRenderer(dependencies, {
      label: "Preparing Rig update",
      successLabel: "Update finished",
      execute: (report) =>
        Effect.sync(() => {
          report("Checking for updates");
          report.complete({ label: "Current version: 0.0.41" });
          report.complete({
            label: "Updated Rig",
            detail: "  npm install\n    changed 1 package",
            mutedDetail: true,
          });
          return "ready";
        }),
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
    const dependencies = {
      isInteractive: false,
      write(value: string) {
        writes.push(String(value));
      },
      render() {
        throw new Error("Non-interactive output must not mount Ink.");
      },
    };

    await runRenderer(dependencies, {
      label: "Checking Rig",
      execute: () => Effect.void,
      renderSuccess() {
        return "";
      },
    });

    expect(writes).toEqual(["✔ Checking Rig\n"]);
  });

  it("renders interactive progress and success", async () => {
    const TestRenderer = new CommandUiTestRenderer();
    const dependencies = {
      isInteractive: true,
      write: () => undefined,
      render: (tree: ReactElement) => TestRenderer.render(tree),
    };

    const result = await runRenderer(dependencies, {
      label: "Preparing Rig update",
      successLabel: "Update finished",
      execute: (report) =>
        Effect.sync(() => {
          report("Checking for updates");
          report.complete({ label: "Checked for updates" });
          return 42;
        }),
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
    const TestRenderer = new CommandUiTestRenderer();
    const dependencies = {
      isInteractive: true,
      write: () => undefined,
      render: (tree: ReactElement) => TestRenderer.render(tree),
    };

    await expect(
      runRenderer(dependencies, {
        label: "Preparing Rig update",
        execute: (report) =>
          Effect.sync(() => report("Updating Rig")).pipe(
            Effect.andThen(
              Effect.fail(
                new RigError({ code: "INTERNAL_ERROR", message: "Registry unavailable" }),
              ),
            ),
          ),
        renderSuccess() {
          return "unreachable";
        },
      }),
    ).rejects.toThrow("Registry unavailable");

    expect(TestRenderer.lastFrame()).toBe("✖ Updating Rig\nRegistry unavailable");
    expect(TestRenderer.unmounted).toBe(true);
  });

  it("renders non-Error failures against the initial label after completion", async () => {
    const TestRenderer = new CommandUiTestRenderer();
    const dependencies = {
      isInteractive: true,
      write: () => undefined,
      render: (tree: ReactElement) => TestRenderer.render(tree),
    };

    await expect(
      runRenderer(dependencies, {
        label: "Preparing Rig update",
        execute: (report) =>
          Effect.sync(() => report.complete({ label: "Checked version" })).pipe(
            Effect.andThen(Effect.fail("offline")),
          ),
        renderSuccess() {
          return "unreachable";
        },
      }),
    ).rejects.toBe("offline");

    expect(TestRenderer.lastFrame()).toBe("✔ Checked version\n✖ Preparing Rig update\noffline");
  });

  it("formats subprocess output and omits empty groups", async () => {
    expect(
      await Effect.runPromise(
        CommandUiRendererService.use((service) =>
          service.formatUpdateCommandOutputGroups({
            steps: [
              { command: "/runtime/bin/npm", args: ["install", "@rendotdev/rig"] },
              { command: "/runtime/bin/rig", args: ["init"] },
            ],
            outputs: ["changed 1 package\nready\n", ""],
          }),
        ).pipe(Effect.provide(commandUiRendererLayer)),
      ),
    ).toBe("  npm install @rendotdev/rig\n    changed 1 package\n    ready");
    expect(
      await Effect.runPromise(
        CommandUiRendererService.use((service) =>
          service.formatUpdateCommandOutputGroups({
            steps: [{ command: "rig", args: ["init"] }],
            outputs: [],
          }),
        ).pipe(Effect.provide(commandUiRendererLayer)),
      ),
    ).toBeUndefined();
  });
});
