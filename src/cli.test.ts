import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BunRuntimeBootstrap, CliApplication, isCliEntrypoint } from "./cli";
import { RigPaths } from "./config/paths";
import { ToolCreator } from "./tools/create";

class CliWorkspaceStore {
  private readonly paths: string[] = [];
  private readonly originalEnv = { ...process.env };
  private readonly originalCwd = process.cwd();
  private readonly originalExitCode = process.exitCode;

  async create(prefix = "rig-cli-"): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    process.chdir(this.originalCwd);
    process.env = { ...this.originalEnv };
    process.exitCode = this.originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

class CliHarness {
  readonly logs: string[] = [];
  readonly errors: string[] = [];

  constructor(
    private readonly homeDir?: string,
    private readonly agentSync = false,
    private readonly updateCheck = false,
  ) {
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
    if (this.agentSync) delete process.env.RIG_AGENT_SYNC;
    else process.env.RIG_AGENT_SYNC = "0";
    if (this.updateCheck) delete process.env.RIG_UPDATE_CHECK;
    else process.env.RIG_UPDATE_CHECK = "0";
    process.env.RIG_LOG = "0";
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

    const defaultStatus = await cli.run([]);
    expect(defaultStatus).toContain("Rig is ready.");
    expect(defaultStatus).toMatch(/Version:\s+\d+\.\d+\.\d+/);

    const initStatus = await cli.run(["init"]);
    expect(initStatus).toContain("Rig is ready.");
    expect(initStatus).toMatch(/Version:\s+\d+\.\d+\.\d+/);
    expect(await cli.run(["doctor"])).toContain("Status: OK");
  });

  test("prints update notices from default status", async () => {
    const home = await workspaces.create();
    const paths = new RigPaths({ homeDir: home });
    await mkdir(paths.rigDir, { recursive: true });
    await writeFile(
      paths.updateCheckCachePath,
      `${JSON.stringify({ checkedAt: Date.now(), latestVersion: "999.0.0" })}\n`,
      "utf8",
    );

    const output = await new CliHarness(home, false, true).run([]);

    expect(output).toContain("Version:");
    expect(output).toContain("Rig update available: @rendotdev/rig");
    expect(output).toContain("-> 999.0.0");
  });

  test("prints rig home folder migration notices", async () => {
    const migratedHome = await workspaces.create();
    await mkdir(join(migratedHome, ".rig", "tools", "legacy"), { recursive: true });
    await writeFile(
      join(migratedHome, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/.rig/tools", customRegistries: [] })}\n`,
      "utf8",
    );

    const migratedOutput = await new CliHarness(migratedHome).run([]);

    expect(migratedOutput).toContain("Rig moved its home folder:");
    expect(migratedOutput).toContain(`From: ${join(migratedHome, ".rig")}`);
    expect(migratedOutput).toContain("Updated base registry: ~/rig/tools");

    const unchangedHome = await workspaces.create();
    await mkdir(join(unchangedHome, ".rig", "tools", "legacy"), { recursive: true });
    await writeFile(
      join(unchangedHome, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/custom-tools", customRegistries: [] })}\n`,
      "utf8",
    );

    const unchangedOutput = await new CliHarness(unchangedHome).run([]);

    expect(unchangedOutput).toContain("Rig moved its home folder:");
    expect(unchangedOutput).not.toContain("Updated base registry: ~/rig/tools");

    const defaultManualHome = await workspaces.create();
    await mkdir(join(defaultManualHome, ".rig", "tools", "legacy"), { recursive: true });
    await writeFile(
      join(defaultManualHome, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/.rig/tools", customRegistries: [] })}\n`,
      "utf8",
    );
    await mkdir(join(defaultManualHome, "rig", "tools", "current"), { recursive: true });
    await writeFile(
      join(defaultManualHome, "rig", "rig.json"),
      `${JSON.stringify({
        version: 1,
        baseRegistryDir: "~/rig/tools",
        customRegistries: [],
        cronJobs: [],
      })}\n`,
      "utf8",
    );

    const defaultManualOutput = await new CliHarness(defaultManualHome).run([]);
    expect(defaultManualOutput).toContain("Rig home folder migration needs your attention:");

    const manualHome = await workspaces.create();
    await mkdir(join(manualHome, ".rig", "tools", "legacy"), { recursive: true });
    await writeFile(
      join(manualHome, ".rig", "rig.json"),
      `${JSON.stringify({ version: 1, baseRegistryDir: "~/.rig/tools", customRegistries: [] })}\n`,
      "utf8",
    );
    await mkdir(join(manualHome, "rig", "tools", "current"), { recursive: true });
    await writeFile(
      join(manualHome, "rig", "rig.json"),
      `${JSON.stringify({
        version: 1,
        baseRegistryDir: "~/rig/tools",
        customRegistries: [],
        cronJobs: [],
      })}\n`,
      "utf8",
    );

    const manualCli = new CliHarness(manualHome);
    const manualOutput = await manualCli.run(["doctor"]);

    expect(manualOutput).toContain("Rig home folder migration needs your attention:");
    expect(manualOutput).toContain("Rig found data in both the old and new folders.");
    expect(manualOutput).toContain("This migration prompt is versioned");

    manualCli.logs.length = 0;
    const repeatedOutput = await manualCli.run(["doctor"]);
    expect(repeatedOutput).not.toContain("Rig home folder migration needs your attention:");
    expect(repeatedOutput).toContain("Status: OK");
  });

  test("prints config and manages registries", async () => {
    const home = await workspaces.create();
    const noHomeCli = new CliHarness();
    expect(await noHomeCli.run(["config", "path"])).toContain("rig/rig.json");
    vi.restoreAllMocks();

    const cli = new CliHarness(home);
    expect(await cli.run(["config", "show"])).toContain('"version": 1');
    expect(await cli.run(["registry", "list"])).toContain('"registries"');

    const custom = join(home, "custom-tools");
    expect(await cli.run(["registry", "create", custom])).toContain(custom);
    expect(await cli.run(["registry", "remove", custom])).toContain('"customRegistries": []');
    expect(await cli.run(["registry", "create"])).toContain(process.cwd());
  });

  test("creates, lists, inspects, and renders help for tools", async () => {
    const home = await workspaces.create();
    const cli = new CliHarness(home);

    expect(await cli.run(["help"])).toContain("# rig");
    expect(await cli.run(["create", "sample"])).toContain("Created tool sample");
    expect(await cli.run(["help"])).toContain(
      "The `rig` CLI is installed on this machine. It is _your_ CLI.",
    );
    expect(await cli.run(["help", "sample"])).toContain("# sample");
    expect(await cli.run(["help", "sample.example"])).toContain("Tool: sample");
    expect(await cli.run(["inspect", "sample.example"])).toContain('"id": "sample.example"');
    const listOutput = await cli.run(["list"]);
    expect(listOutput).toContain("sample.example");
    expect(listOutput).toContain("rig run sample.example text=example #");
    expect(await cli.run(["list", "--json"])).toContain('"tools"');
    expect(await cli.run(["ls", "--plain"])).toContain("rig run sample.example text=example #");
    expect(await cli.run(["edit", "sample"])).toContain(
      join(home, "rig", "tools", "sample", "index.rig.ts"),
    );
    expect(await cli.run(["remove", "sample"])).toContain("Removed tool sample");
    expect(await cli.run(["list"])).toContain("No Rig tools found.");
  });

  test("syncs agent instruction files after commands", async () => {
    const home = await workspaces.create();
    const project = join(home, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "# Agent notes\n", "utf8");
    process.chdir(project);

    const cli = new CliHarness(home, true);

    // Add a custom registry inside the project so sync targets it
    const projectRegistry = join(project, "rig-tools");
    expect(await cli.run(["registry", "create", projectRegistry])).toContain(projectRegistry);
    expect(await cli.run(["create", "sample"])).toContain("Created tool sample");

    const syncedTool = await readFile(join(home, "rig", "tools", "sample", "index.rig.ts"), "utf8");
    expect(syncedTool).toContain("// rig:runtime-reference:start");

    const synced = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(synced).toContain("<!-- rig:agent-instructions:start -->");
    expect(synced).toContain("The `rig` CLI is installed on this machine. It is *your* CLI.");
    expect(synced).toContain("sample.example");

    expect(await cli.run(["remove", "sample"])).toContain("Removed tool sample");
    const updated = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(updated).toContain("No Rig tools found.");
    expect(updated).not.toContain("sample.example");
  });

  test("ignores agent instruction sync failures", async () => {
    const home = await workspaces.create();
    const project = join(home, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(home, "rig", "tools", "broken"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "# Agent notes\n", "utf8");
    await writeFile(join(home, "rig", "tools", "broken", "index.rig.ts"), "nope", "utf8");
    process.chdir(project);

    expect(await new CliHarness(home, true).run(["config", "path"])).toContain("rig/rig.json");
  });

  test("runs and typechecks tools", async () => {
    const home = await workspaces.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const cli = new CliHarness(home);

    expect(await cli.run(["run", "sample.example", "--input", '{"text":"cli"}'])).toContain(
      '"text": "cli"',
    );
    expect(await cli.run(["run", "sample.example", "Agent", "--dry-run"])).toContain(
      '"dryRun": true',
    );
    expect(await cli.run(["typecheck", "sample"])).toContain('"ok": true');
    expect(process.exitCode).toBe(0);
  });

  test("manages tool env files", async () => {
    const home = await workspaces.create();
    const toolDir = join(home, "rig", "tools", "configured");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "configured",
  description: "Configured env test tool.",
  env: rig.z.object({ REMOVE_ME: rig.z.string().optional(), TOKEN: rig.z.string() }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ token: rig.z.string() }),
      run: async (context) => ({ token: context.env.TOKEN }),
    }),
  },
});
`,
      "utf8",
    );
    const cli = new CliHarness(home);

    expect(await cli.run(["env", "configured"])).toContain('"set": false');
    expect(await cli.run(["env", "configured", "TOKEN=secret", "REMOVE_ME=temp"])).toContain(
      '"updated": true',
    );
    expect(await cli.run(["env", "configured", "remove", "REMOVE_ME"])).toContain(
      '"removedKeys": [\n    "REMOVE_ME"\n  ]',
    );
    expect(await readFile(join(toolDir, ".env"), "utf8")).toBe("TOKEN=secret\n");
  });

  test("manages cron jobs", async () => {
    const home = await workspaces.create();
    const originalBun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
    const cron = Object.assign(
      vi.fn<(path: string, schedule: string, title: string) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      {
        parse: vi.fn<(expression: string) => Date | null>(
          () => new Date("2026-07-01T00:00:00.000Z"),
        ),
        remove: vi.fn<(title: string) => Promise<void>>(() => Promise.resolve()),
      },
    );
    vi.stubGlobal("Bun", { ...(originalBun as Record<string, unknown>), cron });
    await new ToolCreator({ homeDir: home }).create("sample");
    const cli = new CliHarness(home);

    expect(await cli.run(["cron", "list"])).toContain('"cronJobs": []');
    expect(
      await cli.run([
        "cron",
        "add",
        "weekly-jira",
        "sample.example",
        "@weekly",
        "--input",
        '{"text":"Jira"}',
      ]),
    ).toContain('"name": "weekly-jira"');
    expect(await cli.run(["cron", "run", "weekly-jira"])).toContain('"text": "Jira"');
    expect(await cli.run(["cron", "remove", "weekly-jira"])).toContain('"removed": true');
    expect(cron).toHaveBeenCalledWith(expect.any(String), "@weekly", "weekly-jira");
    expect(cron.remove).toHaveBeenCalledWith("weekly-jira");
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

  test("resolves and runs the bundled Bun runtime bootstrap", async () => {
    const home = await workspaces.create();
    const bunPath = join(home, "node_modules", "bun", "bin", "bun.exe");
    const entrypoint = join(home, "dist", "rig.js");
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const spawn = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      return { status: calls.length === 1 ? 7 : null };
    }) as never;

    await mkdir(join(home, "node_modules", "bun", "bin"), { recursive: true });
    await writeFile(bunPath, "", "utf8");

    const bootstrap = new BunRuntimeBootstrap(home, spawn, {}, () => undefined);
    expect(bootstrap.resolveBunPath()).toBe(bunPath);
    expect(bootstrap.shouldBootstrap()).toBe(true);
    expect(bootstrap.run(pathToFileURL(entrypoint).href, ["node", "rig", "list"])).toBe(7);
    expect(bootstrap.autoInstallFlag()).toBe("--install=fallback");
    expect(calls[0]).toMatchObject({
      command: bunPath,
      args: ["--install=fallback", entrypoint, "list"],
      env: { RIG_BUN_BOOTSTRAPPED: "1" },
    });
    expect(bootstrap.run(pathToFileURL(entrypoint).href, ["node", "rig"])).toBe(1);
    expect(
      new BunRuntimeBootstrap(join(home, "missing"), spawn, {}, () => undefined).run(
        pathToFileURL(entrypoint).href,
        ["node", "rig"],
      ),
    ).toBeUndefined();
    expect(
      new BunRuntimeBootstrap(home, spawn, { RIG_BUN_BOOTSTRAPPED: "1" }, () => undefined).run(
        pathToFileURL(entrypoint).href,
        ["node", "rig"],
      ),
    ).toBeUndefined();
    expect(
      new BunRuntimeBootstrap(
        home,
        spawn,
        { RIG_BUN_BOOTSTRAPPED: "1" },
        () => undefined,
      ).shouldBootstrap(),
    ).toBe(false);
    expect(
      new BunRuntimeBootstrap(
        home,
        spawn,
        { RIG_DISABLE_BUN_BOOTSTRAP: "1" },
        () => undefined,
      ).shouldBootstrap(),
    ).toBe(false);
    expect(
      new BunRuntimeBootstrap(home, spawn, {}, () => ({ version: "test" })).shouldBootstrap(),
    ).toBe(false);
    expect(
      new BunRuntimeBootstrap(
        home,
        spawn,
        { RIG_BUN_PATH: bunPath },
        () => undefined,
      ).resolveBunPath(),
    ).toBe(bunPath);
    expect(new BunRuntimeBootstrap(home, spawn, {}).shouldBootstrap()).toBe(
      (globalThis as typeof globalThis & { Bun?: unknown }).Bun === undefined,
    );
  });

  test("prints queried run output and pipeline ids", async () => {
    const home = await workspaces.create();
    const cli = new CliHarness(home);

    await new ToolCreator({ homeDir: home }).create("sample");

    expect(await cli.run(["run", "sample.example", "text=hello", "--query", "data.text"])).toBe(
      "hello",
    );

    cli.logs.length = 0;
    expect(await cli.run(["run", "sample.example", "text=hello", "--query", "data"])).toContain(
      '"text": "hello"',
    );

    cli.logs.length = 0;
    const output = await cli.run(["run", "sample.example", "text=hello", "--as", "first"]);
    expect(output).toContain('"pipe"');
    expect(output).toContain('"first"');
    expect(output).toContain('"text": "hello"');
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
    await expect(cli.run(["run", "sample", "x"])).rejects.toThrow("exit:1");
    expect(cli.errorOutput).toContain("Command id must use <tool>.<command>: sample");
    await new ToolCreator({ homeDir: home }).create("sample");
    await expect(cli.run(["run", "sample.example", "text=x", "--as", "bad.id"])).rejects.toThrow(
      "exit:1",
    );
    expect(cli.errorOutput).toContain("Pipeline id is invalid: bad.id");
    await expect(
      cli.run(["run", "sample.example", "text=x", "--query", "data.missing"]),
    ).rejects.toThrow("exit:1");
    expect(cli.errorOutput).toContain("Query is missing: data.missing");
    await expect(
      cli.run(["run", "sample.example", "text=x", "--query", "data.text.extra"]),
    ).rejects.toThrow("exit:1");
    expect(cli.errorOutput).toContain("Query cannot access: data.text.extra");

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
