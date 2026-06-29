import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliApplication, isCliEntrypoint } from "../src/cli";
import { ToolCreator } from "../src/tools/create";

class CliWorkspaceStore {
  private readonly paths: string[] = [];
  private readonly originalEnv = { ...process.env };
  private readonly originalExitCode = process.exitCode;

  async create(prefix = "rig-cli-"): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    process.env = { ...this.originalEnv };
    process.exitCode = this.originalExitCode;
    vi.restoreAllMocks();
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

class CliHarness {
  readonly logs: string[] = [];
  readonly errors: string[] = [];

  constructor(private readonly homeDir?: string) {
    vi.spyOn(console, "log").mockImplementation((...values) => {
      this.logs.push(values.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...values) => {
      this.errors.push(values.map(String).join(" "));
    });
  }

  async run(args: string[]): Promise<string> {
    process.exitCode = undefined;
    if (this.homeDir) process.env.RIG_HOME = this.homeDir;
    else delete process.env.RIG_HOME;
    await new CliApplication().run(["node", "rig", ...args]);
    return this.output;
  }

  get output(): string {
    return this.logs.join("\n");
  }

  get errorOutput(): string {
    return this.errors.join("\n");
  }
}

const workspaces = new CliWorkspaceStore();

afterEach(async () => {
  await workspaces.cleanup();
});

describe("cli application", () => {
  test("prints default status, initializes, and runs doctor", async () => {
    const home = await workspaces.create();
    const cli = new CliHarness(home);

    expect(await cli.run([])).toContain("Rig is ready.");
    expect(await cli.run(["init"])).toContain("Rig initialized.");
    expect(await cli.run(["doctor"])).toContain("Status: OK");
  });

  test("prints config and manages registries", async () => {
    const home = await workspaces.create();
    const noHomeCli = new CliHarness();
    expect(await noHomeCli.run(["config", "path"])).toContain(".rig/rig.json");
    vi.restoreAllMocks();

    const cli = new CliHarness(home);
    expect(await cli.run(["config", "show"])).toContain('"version": 1');
    expect(await cli.run(["registry", "list"])).toContain('"registries"');

    const custom = join(home, "custom-tools");
    expect(await cli.run(["registry", "add", custom])).toContain(custom);
    expect(await cli.run(["registry", "remove", custom])).toContain('"customRegistries": []');
  });

  test("creates, lists, inspects, and renders help for tools", async () => {
    const home = await workspaces.create();
    const cli = new CliHarness(home);

    expect(await cli.run(["tool", "create", "sample"])).toContain("Created tool sample");
    expect(await cli.run(["help"])).toContain("# Rig help");
    expect(await cli.run(["llm.txt"])).toContain("# Rig llm.txt");
    expect(await cli.run(["help", "sample"])).toContain("# sample");
    expect(await cli.run(["help", "sample", "example"])).toContain("Tool: sample");
    expect(await cli.run(["inspect", "sample", "example"])).toContain('"id": "sample.example"');
    expect(await cli.run(["tool", "inspect", "sample", "example"])).toContain(
      '"command": "example"',
    );
    expect(await cli.run(["list"])).toContain('"tools"');
    expect(await cli.run(["ls", "--plain"])).toContain("sample.example Example command");
  });

  test("runs and typechecks tools", async () => {
    const home = await workspaces.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const cli = new CliHarness(home);

    expect(await cli.run(["run", "sample", "example", "--input", '{"text":"cli"}'])).toContain(
      '"text": "cli"',
    );
    expect(await cli.run(["run", "sample", "example", "Agent", "--dry-run"])).toContain(
      '"dryRun": true',
    );
    expect(await cli.run(["typecheck", "sample"])).toContain('"ok": true');
    expect(process.exitCode).toBe(0);
  });

  test("manages dev links", async () => {
    const home = await workspaces.create();
    const binDir = join(home, "bin");
    const cli = new CliHarness(home);

    expect(await cli.run(["dev", "link", "--bin-dir", binDir])).toContain("Rig dev link is ready");
    expect(await cli.run(["dev", "status", "--bin-dir", binDir])).toContain('"exists": true');
    expect(await cli.run(["dev", "unlink", "--bin-dir", binDir])).toContain("Rig dev link removed");

    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rig"), "#!/usr/bin/env bash\necho other\n", "utf8");
    expect(await cli.run(["dev", "link", "--bin-dir", binDir, "--force"])).toContain(
      "Rig dev link is ready",
    );
    expect(await cli.run(["dev", "unlink", "--bin-dir", binDir, "--force"])).toContain(
      "Rig dev link removed",
    );
  });

  test("handles errors, entrypoint checks, and version fallbacks", async () => {
    const home = await workspaces.create();
    const cli = new CliHarness(home);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(cli.run(["help", "missing"])).rejects.toThrow("exit:1");
    expect(cli.errorOutput).toContain("TOOL_NOT_FOUND: Tool not found: missing");
    expect(cli.errorOutput).toContain('"name": "missing"');

    const app = new CliApplication() as unknown as {
      printError(error: unknown): never;
      version(): string;
    };
    expect(() => app.printError(new Error("plain failure"))).toThrow("exit:1");
    expect(cli.errorOutput).toContain("INPUT_ERROR: plain failure");

    process.env.RIG_PACKAGE_ROOT = process.cwd();
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(app.version()).toBe(packageJson.version);

    const packageRoot = await workspaces.create();
    process.env.RIG_PACKAGE_ROOT = packageRoot;
    expect(app.version()).toBe("0.0.0");
    await writeFile(join(packageRoot, "package.json"), '{"version":123}\n', "utf8");
    expect(app.version()).toBe("0.0.0");

    const entrypoint = join(packageRoot, "cli.ts");
    expect(isCliEntrypoint(pathToFileURL(entrypoint).href, entrypoint)).toBe(true);
    expect(isCliEntrypoint(import.meta.url, "")).toBe(false);
    expect(isCliEntrypoint(import.meta.url, entrypoint)).toBe(false);
  });
});
