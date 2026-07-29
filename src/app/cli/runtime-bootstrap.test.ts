import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  RuntimeBootstrapConfigService,
  RuntimeBootstrapPlatformService,
  RuntimeBootstrapService,
} from "./runtime-bootstrap";

const runtimeBootstrapLayerFor = (params: {
  env?: NodeJS.ProcessEnv;
  bunGlobal?: unknown;
  spawn?: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    status: number | null;
  };
}) => {
  const configLayer = Layer.succeed(RuntimeBootstrapConfigService, { env: params.env ?? {} });
  const platformLayer = Layer.succeed(RuntimeBootstrapPlatformService, {
    spawn: Effect.fn("RuntimeBootstrapPlatformService.spawn")(function* (command, args, options) {
      return (params.spawn?.(command, args, options) ?? { status: 0 }) as never;
    }),
    bunGlobal: Effect.succeed(params.bunGlobal),
    realpath: Effect.fn("RuntimeBootstrapPlatformService.realpath")(function* (path) {
      return path;
    }),
    pathToFileUrl: Effect.fn("RuntimeBootstrapPlatformService.pathToFileUrl")(function* (path) {
      return pathToFileURL(path);
    }),
  });
  return RuntimeBootstrapService.layer.pipe(Layer.provide(Layer.merge(configLayer, platformLayer)));
};

describe("RuntimeBootstrapService", () => {
  it("runs Bun with the configured executable and bootstrap guard", async () => {
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const entrypoint = "/workspace/dist/rig.mjs";
    const layer = runtimeBootstrapLayerFor({
      env: { RIG_BUN_PATH: "/runtime/bun" },
      bunGlobal: undefined,
      spawn: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: calls.length === 1 ? 7 : null };
      },
    });
    const first = await Effect.runPromise(
      RuntimeBootstrapService.use((service) =>
        Effect.all({
          bunPath: service.resolveBunPath,
          shouldBootstrap: service.shouldBootstrap,
          result: service.run({
            metaUrl: pathToFileURL(entrypoint).href,
            argv: ["node", "rig", "list"],
          }),
          flag: service.autoInstallFlag,
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(first).toEqual({
      bunPath: "/runtime/bun",
      shouldBootstrap: true,
      result: 7,
      flag: "--install=fallback",
    });
    expect(calls[0]).toMatchObject({
      command: "/runtime/bun",
      args: ["--install=fallback", entrypoint, "list"],
      env: { RIG_BUN_BOOTSTRAPPED: "1" },
    });
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) =>
          service.run({ metaUrl: pathToFileURL(entrypoint).href, argv: ["node", "rig"] }),
        ).pipe(Effect.provide(layer)),
      ),
    ).toBe(1);
  });

  it("skips bootstrap for guarded or existing Bun runtimes", async () => {
    const bootstrappedLayer = runtimeBootstrapLayerFor({
      env: { RIG_BUN_BOOTSTRAPPED: "1" },
      bunGlobal: undefined,
    });
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) =>
          Effect.all({
            result: service.run({ metaUrl: import.meta.url, argv: [] }),
            should: service.shouldBootstrap,
          }),
        ).pipe(Effect.provide(bootstrappedLayer)),
      ),
    ).toEqual({ result: undefined, should: false });
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) => service.shouldBootstrap).pipe(
          Effect.provide(
            runtimeBootstrapLayerFor({
              env: { RIG_DISABLE_BUN_BOOTSTRAP: "1" },
              bunGlobal: undefined,
            }),
          ),
        ),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) => service.shouldBootstrap).pipe(
          Effect.provide(runtimeBootstrapLayerFor({ bunGlobal: { version: "test" } })),
        ),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) => service.resolveBunPath).pipe(
          Effect.provide(runtimeBootstrapLayerFor({ bunGlobal: undefined })),
        ),
      ),
    ).toBe("bun");
  });

  it("matches canonical entrypoint paths", async () => {
    const entrypoint = "/workspace/cli.ts";
    expect(
      await Effect.runPromise(
        RuntimeBootstrapService.use((service) =>
          Effect.all([
            service.isEntrypoint(pathToFileURL(entrypoint).href, entrypoint),
            service.isEntrypoint(import.meta.url, ""),
            service.isEntrypoint(import.meta.url, entrypoint),
          ]),
        ).pipe(Effect.provide(runtimeBootstrapLayerFor({ bunGlobal: undefined }))),
      ),
    ).toEqual([true, false, false]);
  });
});
