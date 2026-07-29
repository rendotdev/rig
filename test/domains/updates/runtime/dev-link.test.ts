import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DevLinkConfigService } from "../../../../src/domains/updates/config/dev-link-config";
import { DevLinkPlatformService } from "../../../../src/domains/updates/repo/dev-link-repository";
import {
  DevLinkMutationService,
  DevLinkPathService,
  DevLinkRenderService,
  DevLinkStateService,
} from "../../../../src/domains/updates/service/dev-link";
import type { DevLinkCommandOptions } from "../../../../src/domains/updates/types/dev-link";
import { DevLinkService } from "../../../../src/domains/updates/runtime/dev-link";

const workspaces: string[] = [];

const createWorkspace = async () => {
  const path = await mkdtemp(join(tmpdir(), "rig-test-workspace-"));
  workspaces.push(path);
  return path;
};

const createRigRepo = async (path: string) => {
  const cliDirectory = join(path, "src", "app", "cli");
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(join(path, "package.json"), '{"name":"rig"}\n', "utf8");
  await writeFile(join(cliDirectory, "entrypoint.ts"), "console.log('rig dev');\n", "utf8");
};

const createDevLinkLayer = (params: {
  homeDir: string;
  repoRoot: string;
  platform?: NodeJS.Platform;
  pathEnvironment?: string;
}) => {
  const configLayer = Layer.succeed(DevLinkConfigService, {
    get: Effect.succeed({
      homeDir: params.homeDir,
      repoRoot: params.repoRoot,
      platform: params.platform ?? process.platform,
      pathEnvironment: params.pathEnvironment ?? process.env.PATH ?? "",
      pathDelimiter: delimiter,
    }),
  });
  const pathLayer = DevLinkPathService.layer.pipe(
    Layer.provide(Layer.merge(configLayer, DevLinkPlatformService.layer)),
  );
  const stateLayer = DevLinkStateService.layer.pipe(
    Layer.provide(Layer.mergeAll(configLayer, DevLinkPlatformService.layer, pathLayer)),
  );
  const mutationLayer = DevLinkMutationService.layer.pipe(
    Layer.provide(Layer.mergeAll(configLayer, DevLinkPlatformService.layer, pathLayer, stateLayer)),
  );
  return DevLinkService.layer.pipe(
    Layer.provide(Layer.mergeAll(mutationLayer, stateLayer, DevLinkRenderService.layer)),
  );
};

const run = <Result>(
  layer: Layer.Layer<DevLinkService, never, never>,
  operation: (service: DevLinkService["Service"]) => Effect.Effect<Result, unknown>,
) => Effect.runPromise(DevLinkService.use(operation).pipe(Effect.provide(layer)));

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dev link", () => {
  test("links and unlinks a rig dev shim", async () => {
    const home = await createWorkspace();
    const repoRoot = await createWorkspace();
    await createRigRepo(repoRoot);
    const layer = createDevLinkLayer({ homeDir: home, repoRoot });
    const linked = await run(layer, (service) => service.link());
    expect(linked).toMatchObject({ exists: true, isRigDevShim: true, pointsToCurrentRepo: true });
    expect(existsSync(linked.shimPath)).toBe(true);
    const shim = await readFile(linked.shimPath, "utf8");
    expect(shim).toContain("Rig dev shim");
    expect(shim).toContain("bun --install=fallback run");

    const unlinked = await run(layer, (service) => service.unlink());
    expect(unlinked.exists).toBe(false);
    expect(existsSync(linked.shimPath)).toBe(false);
  });

  test("refuses to overwrite a non-Rig shim without force", async () => {
    const home = await createWorkspace();
    const repoRoot = await createWorkspace();
    await createRigRepo(repoRoot);
    const binDir = join(home, ".local", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rig"), "#!/usr/bin/env bash\necho nope\n", "utf8");
    const layer = createDevLinkLayer({ homeDir: home, repoRoot, platform: "linux" });
    await expect(run(layer, (service) => service.link())).rejects.toThrow(
      "Refusing to overwrite existing file",
    );
  });

  test("renders link and unlink results through the service", async () => {
    const homeDir = "/home/rig";
    const repoRoot = await createWorkspace();
    await createRigRepo(repoRoot);
    const layer = createDevLinkLayer({ homeDir, repoRoot, pathEnvironment: "/bin" });
    const status = {
      repoRoot,
      binDir: "/home/rig/.local/bin",
      shimPath: "/home/rig/.local/bin/rig",
      exists: true,
      isRigDevShim: true,
      pointsToCurrentRepo: true,
      binDirOnPath: false,
    };
    expect(await run(layer, (service) => service.renderLink(status))).toContain(
      "Add /home/rig/.local/bin to PATH",
    );
    expect(
      await run(layer, (service) => service.renderLink({ ...status, binDirOnPath: true })),
    ).not.toContain("Add /home/rig/.local/bin to PATH");
    expect(await run(layer, (service) => service.renderUnlink(status))).toContain(
      "Rig dev link removed.",
    );
    await expect(run(layer, (service) => service.status())).resolves.toBeDefined();
  });

  test("writes a Windows command shim when requested", async () => {
    const home = await createWorkspace();
    const repoRoot = await createWorkspace();
    await createRigRepo(repoRoot);
    const layer = createDevLinkLayer({ homeDir: home, repoRoot, platform: "win32" });
    const options: DevLinkCommandOptions = {};
    const linked = await run(layer, (service) => service.link(options));
    const shim = await readFile(linked.shimPath, "utf8");
    expect(linked.shimPath).toBe(join(home, ".local", "bin", "rig.cmd"));
    expect(linked.pointsToCurrentRepo).toBe(true);
    expect(shim).toContain("@echo off");
    expect(shim).toContain('set "RIG_DEV_REPO=');
    expect(shim).toContain('run "%RIG_DEV_REPO%\\src\\app\\cli\\entrypoint.ts" %*');
  });
});
