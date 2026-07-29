import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { CliCommandService } from "./cli-application";
import { CliPlatformService } from "./cli-platform";
import { CliApplicationService, runCli } from "./composition-root";
import { RuntimeBootstrapService } from "./runtime-bootstrap";

const applicationLayer = (params: {
  bootstrap: (input: { metaUrl: string; argv: string[] }) => Effect.Effect<number | undefined>;
  command: (argv: string[]) => Effect.Effect<void>;
  setExitCode?: (code: number) => Effect.Effect<void>;
}) => {
  const bootstrapLayer = Layer.succeed(RuntimeBootstrapService, {
    run: Effect.fn("RuntimeBootstrapService.run")(params.bootstrap),
    shouldBootstrap: Effect.succeed(false),
    resolveBunPath: Effect.succeed("bun"),
    autoInstallFlag: Effect.succeed("--install=fallback"),
    isEntrypoint: Effect.fn("RuntimeBootstrapService.isEntrypoint")(function* () {
      return true;
    }),
  });
  const commandLayer = Layer.succeed(CliCommandService, {
    run: Effect.fn("CliCommandService.run")(params.command),
  });
  const platformLayer = Layer.succeed(CliPlatformService, {
    cwd: Effect.succeed("/workspace"),
    exists: Effect.fn("CliPlatformService.exists")(function* () {
      return true;
    }),
    readText: Effect.fn("CliPlatformService.readText")(function* () {
      return "";
    }),
    log: Effect.fn("CliPlatformService.log")(function* () {}),
    error: Effect.fn("CliPlatformService.error")(function* () {}),
    printJson: Effect.fn("CliPlatformService.printJson")(function* () {}),
    printQueryResult: Effect.fn("CliPlatformService.printQueryResult")(function* () {}),
    setExitCode: params.setExitCode ?? Effect.fn("CliPlatformService.setExitCode")(function* () {}),
    fail: Effect.fn("CliPlatformService.fail")(function* () {
      return yield* Effect.die("unexpected failure");
    }),
  });
  return CliApplicationService.layer.pipe(
    Layer.provide(Layer.mergeAll(bootstrapLayer, commandLayer, platformLayer)),
  );
};

describe("CLI composition root", () => {
  it("runs the application when Bun bootstrap is unnecessary", async () => {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    const bootstrap = vi.fn(() => Effect.succeed<number | undefined>(undefined));
    const command = vi.fn(() => Effect.void);
    const params = { metaUrl: "file:///rig.ts", argv: ["bun", "rig", "list"] };

    await Effect.runPromise(
      runCli(params).pipe(Effect.provide(applicationLayer({ bootstrap, command }))),
    );

    expect(bootstrap).toHaveBeenCalledWith(params);
    expect(command).toHaveBeenCalledWith(params.argv);
  });

  it("exits with the bootstrap result before running the application", async () => {
    const command = vi.fn(() => Effect.void);
    const setExitCode = vi.fn(() => Effect.void);
    const effect = runCli({ metaUrl: "file:///rig.ts", argv: ["node", "rig"] }).pipe(
      Effect.provide(
        applicationLayer({ bootstrap: () => Effect.succeed(7), command, setExitCode }),
      ),
    );

    await Effect.runPromise(effect);
    expect(setExitCode).toHaveBeenCalledWith(7);
    expect(command).not.toHaveBeenCalled();
  });

  it("uses the injected entrypoint matcher", async () => {
    const layer = Layer.succeed(RuntimeBootstrapService, {
      run: Effect.fn("RuntimeBootstrapService.run")(function* () {
        return undefined;
      }),
      shouldBootstrap: Effect.succeed(false),
      resolveBunPath: Effect.succeed("bun"),
      autoInstallFlag: Effect.succeed("--install=fallback"),
      isEntrypoint: Effect.fn("RuntimeBootstrapService.isEntrypoint")(
        function* (metaUrl, argvPath) {
          return metaUrl === `file://${argvPath}`;
        },
      ),
    });

    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) =>
          service.isEntrypoint("file:///rig.ts", "/rig.ts"),
        ).pipe(Effect.provide(layer)),
      ),
    ).toBe(true);
  });
});
