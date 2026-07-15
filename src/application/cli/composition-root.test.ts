import { describe, expect, it, vi } from "vite-plus/test";
import { CliCompositionRootClass } from "./composition-root";
import { BunRuntimeBootstrapClass } from "./runtime-bootstrap";

describe("CLI composition root", () => {
  it("runs the application when Bun bootstrap is unnecessary", async () => {
    const application = { run: vi.fn<(argv: string[]) => Promise<void>>(async () => undefined) };
    const runtimeBootstrap = {
      run: vi.fn<(params: { metaUrl: string; argv: string[] }) => number | undefined>(
        () => undefined,
      ),
    };
    const root = new CliCompositionRootClass(
      { metaUrl: "file:///rig.ts", argv: ["bun", "rig", "list"] },
      { application: application as never, runtimeBootstrap: runtimeBootstrap as never },
    );

    await root.run();

    expect(runtimeBootstrap.run).toHaveBeenCalledWith({
      metaUrl: "file:///rig.ts",
      argv: ["bun", "rig", "list"],
    });
    expect(application.run).toHaveBeenCalledWith(["bun", "rig", "list"]);
  });

  it("exits with the bootstrap result before running the application", async () => {
    const application = { run: vi.fn<(argv: string[]) => Promise<void>>(async () => undefined) };
    const runtimeBootstrap = {
      run: vi.fn<(params: { metaUrl: string; argv: string[] }) => number | undefined>(() => 7),
    };
    const exit = vi.fn<(code: number) => never>(() => {
      throw new Error("exit");
    });
    const root = new CliCompositionRootClass(
      { metaUrl: "file:///rig.ts", argv: ["node", "rig"] },
      { application: application as never, runtimeBootstrap: runtimeBootstrap as never, exit },
    );

    await expect(root.run()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(7);
    expect(application.run).not.toHaveBeenCalled();
  });

  it("constructs the default dependency graph", () => {
    expect(
      new CliCompositionRootClass({ metaUrl: import.meta.url, argv: process.argv }, {}),
    ).toBeDefined();
    expect(new BunRuntimeBootstrapClass({}, {})).toBeDefined();
  });
});
