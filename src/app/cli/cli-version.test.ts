import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CliVersionService, cliVersionLayer } from "./cli-version";

const originalPackageRoot = process.env.RIG_PACKAGE_ROOT;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalPackageRoot === undefined) delete process.env.RIG_PACKAGE_ROOT;
  else process.env.RIG_PACKAGE_ROOT = originalPackageRoot;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const currentVersion = () =>
  Effect.runPromise(
    CliVersionService.use((service) => service.current).pipe(Effect.provide(cliVersionLayer)),
  );

describe("CliVersionService", () => {
  it("reads the package version and falls back for invalid manifests", async () => {
    process.env.RIG_PACKAGE_ROOT = process.cwd();
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(await currentVersion()).toBe(packageJson.version);

    const packageRoot = await mkdtemp(join(tmpdir(), "rig-version-"));
    temporaryDirectories.push(packageRoot);
    process.env.RIG_PACKAGE_ROOT = packageRoot;
    expect(await currentVersion()).toBe("0.0.0");
    await writeFile(join(packageRoot, "package.json"), '{"version":123}\n', "utf8");
    expect(await currentVersion()).toBe("0.0.0");
  });
});
