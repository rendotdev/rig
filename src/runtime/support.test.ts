import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RigAgentInstructions } from "../agents/instructions";
import { AgentInstructionSyncServiceClass } from "../agents/sync";
import { RigConfigStoreClass } from "../config/config";
import { RigPathsClass } from "../config/paths";
import { rigConfigDefaults } from "../domains/settings/index.ts";
import { DevLinkServiceClass } from "../dev/dev-link";
import { ErrorCodes } from "../errors/codes";
import { RigErrorClass, rigErrors } from "../errors/RigError";
import { ToolDiscoveryServiceClass } from "../registry/discover";
import { RegistryConfigServiceClass } from "../registry/registry";
import { rigPackageRoot } from "./package-root";
import { BunRigShellClass } from "./shell";
import { RuntimeSupportClass } from "./support";
import { RigOutputTruncatorClass } from "./truncation";
import { ToolCreatorClass } from "../tools/create";
import { ToolHelpRendererClass, ToolHelpServiceClass } from "../tools/help";
import { ToolInspectorClass } from "../tools/inspect";
import { ToolDefinitionValidatorClass, ToolLoaderClass } from "../tools/loader";
import { ToolApiMigrationServiceClass } from "../tools/migration/tool-api-migration";
import { ToolRunnerClass } from "../tools/run";
import { ToolRuntimeInstructionSyncServiceClass } from "../tools/runtime-instruction";
import { schemaRenderer } from "../tools/schema";
import { args, createRigToolKit, defineTool, paths, RigTool, rig } from "../tools/sdk";
import { commandIds } from "../tools/types";
import { ToolTypecheckServiceClass } from "../tools/typecheck";

class TempWorkspaceStore {
  private readonly paths: string[] = [];
  private readonly originalEnv = { ...process.env };
  private readonly originalArgv = [...process.argv];
  private readonly originalCwd = process.cwd();
  private readonly originalExecPath = process.execPath;

  async create(prefix = "rig-coverage-"): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    process.chdir(this.originalCwd);
    process.env = { ...this.originalEnv };
    process.argv.splice(0, process.argv.length, ...this.originalArgv);
    Object.defineProperty(process, "execPath", {
      value: this.originalExecPath,
      configurable: true,
    });
    vi.restoreAllMocks();
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

const workspaces = new TempWorkspaceStore();

afterEach(async () => {
  await workspaces.cleanup();
});

async function writeTool(home: string, name: string, source: string, extension = "ts") {
  const toolDir = join(home, "rig", "tools", name);
  await mkdir(toolDir, { recursive: true });
  const toolPath = join(toolDir, `index.rig.${extension}`);
  await writeFile(toolPath, source, "utf8");
  return { toolDir, toolPath };
}

function simpleToolSource(name: string, command = "echo") {
  return `export default (rig) => rig.defineTool({
  name: ${JSON.stringify(name)},
  description: "${name} test tool.",
  commands: {
    ${command}: rig.defineCommand({
      description: "Echo text.",
      input: rig.z.object({ text: rig.z.string().default("default") }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async ({ input }) => ({ text: input.text }),
    }),
  },
});
`;
}

describe("coverage support", () => {
  test("syncs generated runtime comments into tool files", async () => {
    const home = await workspaces.create();
    const created = await new ToolCreatorClass({ homeDir: home }).create("sample");
    const service = new ToolRuntimeInstructionSyncServiceClass({ homeDir: home });

    expect(service.renderPrefix()).toContain("rig.$");
    expect(service.renderPrefix()).toContain("context.cache.query");
    expect(service.renderPrefix()).toContain("// rig:tool-api-version 2");
    expect(service.upsertPrefix("#!/usr/bin/env bun\nconsole.log(1);\n")).toMatch(
      /^#!\/usr\/bin\/env bun\n\/\/ rig:runtime-reference:start/,
    );
    expect(service.upsertPrefix("#!/usr/bin/env bun\nconsole.log(1);\n")).toContain(
      "// rig:tool-api-version 1",
    );
    expect(service.upsertPrefix("// rig:tool-api-version 0\nconsole.log(1);\n")).toContain(
      "// rig:tool-api-version 1",
    );
    expect(service.upsertPrefix("")).toContain("Rig tool runtime");

    const first = await service.sync();
    expect(first.tools).toEqual([{ name: "sample", path: created.toolPath, changed: true }]);
    const synced = await readFile(created.toolPath, "utf8");
    expect(synced).toMatch(/^\/\/ rig:runtime-reference:start/);
    expect(synced).toContain("// rig:tool-api-version 2");
    expect(synced).toContain("Rig tool runtime");
    expect(synced).toContain("Bun Shell");

    const second = await service.sync();
    expect(second.tools).toEqual([{ name: "sample", path: created.toolPath, changed: false }]);

    await writeFile(created.toolPath, synced.replace("Rig tool runtime", "Stale runtime"), "utf8");
    const third = await service.sync();
    expect(third.tools).toEqual([{ name: "sample", path: created.toolPath, changed: true }]);
    expect(await readFile(created.toolPath, "utf8")).not.toContain("Stale runtime");

    const emptyHome = await workspaces.create("rig-coverage-empty-tools-");
    await expect(
      new ToolRuntimeInstructionSyncServiceClass({ homeDir: emptyHome }).sync(),
    ).resolves.toEqual({ tools: [] });
  });

  test("syncs agent instructions, managed blocks, and target discovery", async () => {
    const home = await workspaces.create();
    const project = join(home, "project");
    const nested = join(project, "src");
    const packageProject = join(home, "package-project");
    const packageNested = join(packageProject, "app");
    const globalAgentSource = join(home, "wks", "AGENTS.md");
    const globalAgentLink = join(home, ".pi", "agent", "AGENTS.md");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(nested, ".claude"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await mkdir(join(home, "wks", ".git"), { recursive: true });
    await mkdir(packageNested, { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "# Root agent notes\n", "utf8");
    await writeFile(
      join(project, "CLAUDE.md"),
      "# Ignored Claude notes\n<!-- rig:ignore -->\n",
      "utf8",
    );
    await writeFile(
      join(home, ".claude", "CLAUDE.md"),
      "# Ignored home Claude\n<!-- rig:ignore -->\n",
      "utf8",
    );
    await writeFile(join(nested, "CLAUDE.md"), "# Nested Claude notes\n", "utf8");
    await writeFile(join(nested, "package.json"), "{}\n", "utf8");
    await writeFile(join(packageProject, "package.json"), "{}\n", "utf8");
    await writeFile(join(packageProject, "AGENTS.md"), "# Package notes\n", "utf8");
    await writeFile(globalAgentSource, "# Global agent notes\n", "utf8");
    await writeFile(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ instructions: [globalAgentSource, "./missing.md", 42] }),
      "utf8",
    );
    await symlink(globalAgentSource, globalAgentLink);
    await new RegistryConfigServiceClass({ homeDir: home }).add(join(project, "rig-tools"));
    await new ToolCreatorClass({ homeDir: home }).create("sample");

    const service = new AgentInstructionSyncServiceClass({ homeDir: home, cwd: nested });
    expect(service.renderBlock("No tools found.")).toContain(RigAgentInstructions);
    await expect(
      (service as unknown as { realPath(path: string): Promise<string> }).realPath(
        join(home, "missing"),
      ),
    ).resolves.toBe(join(home, "missing"));
    await expect(
      (service as unknown as { isIgnored(path: string): Promise<boolean> }).isIgnored(
        join(home, "missing"),
      ),
    ).resolves.toBe(false);
    await expect(
      (service as unknown as { isIgnored(path: string): Promise<boolean> }).isIgnored(
        join(project, "CLAUDE.md"),
      ),
    ).resolves.toBe(true);
    expect(
      (
        service as unknown as { instructionScope(path: string): "all" | "visible" }
      ).instructionScope("/tmp/global-agent.md"),
    ).toBe("visible");
    const targets = await service.discoverTargets();
    expect(targets.map((target) => target.path)).toEqual([
      globalAgentLink,
      join(project, "AGENTS.md"),
      join(nested, ".claude", "CLAUDE.md"),
      join(nested, "CLAUDE.md"),
    ]);
    expect(targets.find((target) => target.path === globalAgentLink)?.scope).toBe("all");

    const first = await service.sync();
    expect(first).toMatchObject({ skipped: false });
    expect(first.targets.every((target) => target.changed)).toBe(true);
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toContain(
      "rig run sample.example text=example #",
    );
    expect(await readFile(join(project, "CLAUDE.md"), "utf8")).not.toContain(
      "<!-- rig:agent-instructions:start -->",
    );
    expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf8")).not.toContain(
      "<!-- rig:agent-instructions:start -->",
    );
    expect(await readFile(join(nested, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "<!-- rig:agent-instructions:start -->",
    );
    expect(await readFile(globalAgentSource, "utf8")).toContain(
      "rig run sample.example text=example #",
    );

    const second = await service.sync();
    expect(second.targets.every((target) => target.changed)).toBe(false);

    await writeFile(
      join(project, "AGENTS.md"),
      (await readFile(join(project, "AGENTS.md"), "utf8")).replace(
        "sample # Describe what this tool does.",
        "Stale tools.",
      ),
      "utf8",
    );
    const third = await service.sync();
    expect(
      third.targets.find((target) => target.path === join(project, "AGENTS.md"))?.changed,
    ).toBe(true);

    expect(
      (
        await new AgentInstructionSyncServiceClass({
          homeDir: home,
          cwd: packageNested,
        }).discoverTargets()
      ).map((target) => target.path),
    ).toContain(join(packageProject, "AGENTS.md"));
    expect(
      (
        await new AgentInstructionSyncServiceClass({
          homeDir: home,
          cwd: join(home, "wks"),
        }).discoverTargets()
      ).filter((target) => target.path.endsWith("AGENTS.md")),
    ).toHaveLength(1);

    await mkdir(join(home, ".opencode"), { recursive: true });
    await writeFile(join(home, ".opencode", "opencode.json"), "{", "utf8");
    await expect(service.discoverTargets()).resolves.toEqual(expect.any(Array));
    await writeFile(join(home, ".opencode", "opencode.json"), "[]", "utf8");
    await expect(service.discoverTargets()).resolves.toEqual(expect.any(Array));
    await writeFile(
      join(home, ".opencode", "opencode.json"),
      JSON.stringify({ instructions: ["~/wks/AGENTS.md", join(project, "AGENTS.md")] }),
      "utf8",
    );
    await expect(service.discoverTargets()).resolves.toEqual(expect.any(Array));

    process.env.RIG_AGENT_SYNC = "0";
    await expect(service.sync()).resolves.toEqual({ skipped: true, targets: [] });
    delete process.env.RIG_AGENT_SYNC;

    const emptyHome = await workspaces.create("rig-coverage-empty-");
    const empty = join(emptyHome, "empty");
    await mkdir(empty);
    await expect(
      new AgentInstructionSyncServiceClass({ homeDir: emptyHome, cwd: empty }).sync(),
    ).resolves.toMatchObject({ skipped: false, targets: [] });

    // Exercise canSkipSync: set up a home with config, tool, and stamp file
    const skipHome = await workspaces.create("rig-skip-sync-");
    const skipProject = join(skipHome, "project");
    await mkdir(join(skipProject, ".git"), { recursive: true });
    await writeFile(join(skipProject, "AGENTS.md"), "# Notes\n", "utf8");
    await new RegistryConfigServiceClass({ homeDir: skipHome }).add(join(skipProject, "rig-tools"));
    await new ToolCreatorClass({ homeDir: skipHome }).create("skiptool");

    const skipService = new AgentInstructionSyncServiceClass({
      homeDir: skipHome,
      cwd: skipProject,
    });
    const syncResult = await skipService.sync();
    expect(syncResult.targets.some((t) => t.changed)).toBe(true);

    // Second sync should skip via canSkipSync (stamp exists, no files changed)
    const skipResult = await skipService.sync();
    expect(skipResult.targets.every((t) => !t.changed)).toBe(true);

    // Modify target file to invalidate cache
    await writeFile(join(skipProject, "AGENTS.md"), "# Modified\n", "utf8");
    const reResult = await skipService.sync();
    expect(reResult.targets.some((t) => t.changed)).toBe(true);
  });

  test("fingerprints TypeScript and TSX tools across every configured registry", async () => {
    const home = await workspaces.create();
    const project = join(home, "project");
    const customRegistry = join(project, "rig-tools");
    const agentPath = join(project, "AGENTS.md");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(agentPath, "# Agent notes\n", "utf8");
    await new ToolCreatorClass({ homeDir: home }).create("base");
    await new RegistryConfigServiceClass({ homeDir: home }).add(customRegistry);
    const customToolDir = join(customRegistry, "custom");
    const customToolPath = join(customToolDir, "index.rig.tsx");
    await mkdir(customToolDir, { recursive: true });
    await writeFile(customToolPath, simpleToolSource("custom", "echo"), "utf8");

    const service = new AgentInstructionSyncServiceClass({ homeDir: home, cwd: project });
    await service.sync();
    expect(await readFile(agentPath, "utf8")).toContain("custom.echo");
    const originalStat = await stat(customToolPath);
    const changedSource = (await readFile(customToolPath, "utf8")).replace("echo", "ping");
    await writeFile(customToolPath, changedSource, "utf8");
    await utimes(customToolPath, originalStat.atime, originalStat.mtime);

    const changed = await service.sync();
    expect(changed.targets.some((target) => target.changed)).toBe(true);
    expect(await readFile(agentPath, "utf8")).toContain("custom.ping");
    expect(await readFile(agentPath, "utf8")).not.toContain("custom.echo");
  });

  test("exercises config reads, writes, defaults, and path helpers", async () => {
    const home = await workspaces.create();
    const pathsForHome = new RigPathsClass({ homeDir: home });
    const configStore = new RigConfigStoreClass({ homeDir: home });

    await expect(configStore.read()).rejects.toThrow("Could not read config");
    await mkdir(pathsForHome.rigDir, { recursive: true });
    await writeFile(pathsForHome.configPath, "{ nope", "utf8");
    await expect(configStore.read()).rejects.toThrow("Config is not valid JSON");
    await writeFile(pathsForHome.configPath, '{"version":2}', "utf8");
    await expect(configStore.read()).rejects.toThrow("Rig config is invalid");
    await expect(configStore.write({ version: 2 } as never)).rejects.toThrow(
      "Rig config is invalid",
    );

    const config = rigConfigDefaults.create();
    config.customRegistries = ["~/custom-tools", join(home, "absolute-tools")];
    await configStore.write(config);
    expect(await configStore.read()).toEqual(config);
    expect(configStore.resolvedBaseRegistry({ ...config, baseRegistryDir: "" } as never)).toBe(
      join(home, "rig", "tools"),
    );
    expect(configStore.resolvedCustomRegistries(config)).toEqual([
      join(home, "custom-tools"),
      join(home, "absolute-tools"),
    ]);
    expect(configStore.registryEntries(config).map((entry) => entry.kind)).toEqual([
      "base",
      "custom",
      "custom",
    ]);

    const defaultPaths = new RigPathsClass();
    expect(defaultPaths.homeDir).toBeTruthy();
    expect(pathsForHome.expandTilde("~")).toBe(home);
    expect(pathsForHome.expandTilde("~/tools")).toBe(join(home, "tools"));
    expect(pathsForHome.expandTilde("relative")).toBe("relative");
    expect(pathsForHome.resolve("relative")).toBe(resolve(process.cwd(), "relative"));
    expect(pathsForHome.resolve(join(home, "file"))).toBe(join(home, "file"));
    expect(pathsForHome.defaultBaseRegistryDir).toBe("~/rig/tools");
    expect(pathsForHome.parentDir(join(home, "child", "file.txt"))).toBe(join(home, "child"));
  });

  test("exercises registry configuration and discovery edges", async () => {
    const home = await workspaces.create();
    const service = new RegistryConfigServiceClass({ homeDir: home });
    const pathsForHome = new RigPathsClass({ homeDir: home });

    const listed = await service.list();
    expect(listed.baseRegistryDir).toBe(pathsForHome.resolve("~/rig/tools"));
    await expect(service.add("~/rig/tools")).rejects.toThrow(
      "The base registry is already configured.",
    );

    const custom = join(home, "custom");
    await service.add(custom);
    const addedTwice = await service.add(custom);
    expect(addedTwice.customRegistries).toEqual([custom]);
    await expect(service.remove(join(home, "missing"))).rejects.toThrow(
      "Registry is not configured",
    );

    const discovery = new ToolDiscoveryServiceClass({ homeDir: home });
    expect(discovery.projectRootFor("/")).toBe("/");
    await expect(discovery.find("missing")).rejects.toThrow("Tool not found: missing");

    await mkdir(join(home, "rig", "tools", "empty"), { recursive: true });
    await mkdir(join(home, "rig", "tools", "multi"), { recursive: true });
    await writeFile(join(home, "rig", "tools", "multi", "index.rig.ts"), "export default {};\n");
    await writeFile(join(home, "rig", "tools", "multi", "index.rig.tsx"), "export default {};\n");
    await writeFile(join(home, "rig", "tools", "not-a-dir"), "x\n");

    await expect(discovery.discover()).rejects.toThrow("multiple Rig entry files");

    await rm(join(home, "rig", "tools", "multi", "index.rig.tsx"));
    const tools = await discovery.discover();
    expect(tools.map((tool) => tool.name)).toEqual(["multi"]);
    await expect(
      (
        discovery as unknown as { discoverRegistry(entry: unknown): Promise<unknown[]> }
      ).discoverRegistry({ kind: "custom", path: join(home, "does-not-exist") }),
    ).resolves.toEqual([]);
  });

  test("exercises dev link status, rendering, force, and invalid roots", async () => {
    const home = await workspaces.create();
    const repoRoot = await workspaces.create();
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(repoRoot, "src", "cli.ts"), "console.log('rig');\n", "utf8");

    const binDir = join(home, "bin");
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    const serviceFromCwd = new DevLinkServiceClass({ homeDir: home });
    expect((await serviceFromCwd.status({ binDir })).repoRoot).toBe(process.cwd());

    const service = new DevLinkServiceClass({ homeDir: home, repoRoot });
    const missing = await service.status({ binDir });
    expect(missing.exists).toBe(false);
    expect(missing.binDirOnPath).toBe(true);
    expect(service.renderLinkResult(missing)).toContain("On PATH: yes");

    const linked = await service.link({ binDir });
    expect(linked.pointsToCurrentRepo).toBe(true);
    expect(service.renderLinkResult({ ...linked, binDirOnPath: false })).toContain("Add ");
    expect(service.renderUnlinkResult(linked)).toContain("Rig dev link removed.");

    await writeFile(join(binDir, "rig"), "#!/usr/bin/env bash\necho other\n", "utf8");
    await service.link({ binDir, force: true });
    await writeFile(join(binDir, "rig"), "#!/usr/bin/env bash\necho other\n", "utf8");
    await expect(service.unlink({ binDir })).rejects.toThrow("Refusing to remove non-Rig dev shim");
    const unlinked = await service.unlink({ binDir, force: true });
    expect(unlinked.exists).toBe(false);
    await service.unlink({ binDir });

    await mkdir(join(binDir, "rig"), { recursive: true });
    const directoryShim = await service.status({ binDir });
    expect(directoryShim.exists).toBe(true);
    expect(directoryShim.isRigDevShim).toBe(false);

    delete process.env.PATH;
    expect((await service.status({ binDir })).binDirOnPath).toBe(false);

    await expect(
      new DevLinkServiceClass({ homeDir: home, repoRoot: home }).status(),
    ).rejects.toThrow("Run dev link from the Rig repository root.");
  });

  test("exercises error conversion and exported codes", () => {
    const rigError = new RigErrorClass("INPUT_ERROR", "bad", { field: "x" });
    expect(rigErrors.from(rigError)).toBe(rigError);
    expect(rigErrors.from(new Error("plain"))).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "plain",
    });
    expect(rigErrors.from("string failure")).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "string failure",
    });
    expect(ErrorCodes.SHELL_ERROR).toBe("SHELL_ERROR");
    expect(ErrorCodes.TOOL_RUN_ERROR).toBe("TOOL_RUN_ERROR");
  });

  test("exercises package-root detection modes", async () => {
    const envRoot = await workspaces.create();
    process.env.RIG_PACKAGE_ROOT = envRoot;
    expect(rigPackageRoot.find(import.meta.url)).toBe(envRoot);
    expect(rigPackageRoot.packageFile(import.meta.url, "dist", "rig.mjs")).toBe(
      join(envRoot, "dist", "rig.mjs"),
    );
    delete process.env.RIG_PACKAGE_ROOT;

    const repoRoot = await workspaces.create();
    await mkdir(join(repoRoot, "src"), { recursive: true });
    const cliPath = join(repoRoot, "src", "cli.ts");
    await writeFile(cliPath, "", "utf8");
    process.argv[1] = cliPath;
    expect(rigPackageRoot.find(import.meta.url)).toBe(await realpath(repoRoot));

    process.argv[1] = join(repoRoot, "missing.ts");
    await mkdir(join(repoRoot, "dist"), { recursive: true });
    const execPath = join(repoRoot, "dist", "rig.mjs");
    await writeFile(execPath, "", "utf8");
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
    expect(rigPackageRoot.find(import.meta.url)).toBe(await realpath(repoRoot));

    Object.defineProperty(process, "execPath", {
      value: join(repoRoot, "bin", "bun"),
      configurable: true,
    });
    process.argv[1] = join(repoRoot, "bin", "script");
    expect(rigPackageRoot.find("file:///%7EBUN/root")).toBe(join(repoRoot, "bin"));
    expect(
      (
        rigPackageRoot as unknown as {
          fromEntrypoint(entrypoint: undefined): string | undefined;
        }
      ).fromEntrypoint(undefined),
    ).toBeUndefined();

    const symlinkRoot = await workspaces.create();
    await mkdir(join(symlinkRoot, "src"), { recursive: true });
    const realCli = join(symlinkRoot, "src", "cli.ts");
    const linkedCli = join(symlinkRoot, "src", "linked.ts");
    await writeFile(realCli, "", "utf8");
    await symlink(realCli, linkedCli);
    process.argv[1] = linkedCli;
    Object.defineProperty(process, "execPath", {
      value: join(repoRoot, "bin", "bun"),
      configurable: true,
    });
    expect(rigPackageRoot.find(import.meta.url)).toBe(await realpath(symlinkRoot));

    process.argv[1] = join(repoRoot, "missing", "script");
    Object.defineProperty(process, "execPath", {
      value: join(repoRoot, "missing", "bun"),
      configurable: true,
    });
    const deepModule = join(repoRoot, "a", "b", "c", "d", "e", "f", "g", "h", "i", "mod.ts");
    expect(rigPackageRoot.find(pathToFileURL(deepModule).href)).toBe(
      join(dirname(deepModule), "..", ".."),
    );
    expect(
      (
        rigPackageRoot as unknown as {
          fromModule(metaUrl: string): string | undefined;
        }
      ).fromModule("file:///mod.ts"),
    ).toBeUndefined();
  });

  test("exercises shell execution, JSON parsing, validation, truncation, and timeouts", async () => {
    const shell = new BunRigShellClass({ timeoutMs: 5_000, maxOutputBytes: 20 });
    const success = await shell.exec(["bun", "-e", "console.log('hello')"], {
      cwd: process.cwd(),
      env: { RIG_SHELL_TEST: "1" },
      maxOutputBytes: 100,
    });
    expect(success).toMatchObject({ exitCode: 0, stdout: "hello\n" });

    await expect(shell.$`echo ${"tagged ok"}`).resolves.toMatchObject({
      exitCode: 0,
      stdout: "tagged ok\n",
    });
    await expect(shell.$`printf '%s\n' ${["safe", "two words"]}`).resolves.toMatchObject({
      exitCode: 0,
      stdout: "safe\ntwo words\n",
    });
    await expect(shell.$`printf '%s\n' ${"safe; echo unsafe"}`).resolves.toMatchObject({
      exitCode: 0,
      stdout: "safe; echo unsafe\n",
    });
    await expect(shell.bash("echo bash-ok")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "bash-ok\n",
    });

    const bounded = await shell.exec(
      ["bun", "-e", "process.stdout.write('x'.repeat(5_000_000)); console.error('y'.repeat(100))"],
      { env: { FORCE_COLOR: undefined }, maxOutputBytes: 64 },
    );
    expect(bounded.stdout).toBe(`${"x".repeat(64)}\n[rig: output truncated]`);
    expect(bounded.stderr).toBe(`${"y".repeat(64)}\n[rig: output truncated]`);

    const unicode = await shell.exec(["bun", "-e", "process.stdout.write('😀'.repeat(100))"], {
      maxOutputBytes: 7,
    });
    expect(unicode.stdout).toBe("😀\n[rig: output truncated]");
    expect(unicode.stdout).not.toContain("�");

    const invalidUtf8 = await shell.bash("printf '\\377\\376\\375\\374'", {
      maxOutputBytes: 10,
    });
    expect(invalidUtf8.stdout).toContain("�");

    const noOutput = await shell.exec(["bun", "-e", "process.stdout.write('hidden')"], {
      maxOutputBytes: 0,
    });
    expect(noOutput.stdout).toBe("\n[rig: output truncated]");

    const markerRoot = await workspaces.create("rig-shell-timeout-");
    const delayedMarker = join(markerRoot, "delayed-marker");
    await expect(
      shell.bash(`(sleep 0.2; touch ${delayedMarker}) & wait`, { timeoutMs: 10 }),
    ).rejects.toThrow("Command timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(existsSync(delayedMarker)).toBe(false);

    await expect(
      shell.exec(["bun", "-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 1000)"], {
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Command timed out");
    await expect(
      shell.bash("trap '' TERM; while true; do sleep 1; done", { timeoutMs: 10 }),
    ).rejects.toThrow("Command timed out");

    const failed = await shell.exec(["bun", "-e", "process.exit(2)"]);
    expect(failed).toMatchObject({ exitCode: 2, stdout: "", stderr: "" });
    await expect(shell.exec(["rig-command-that-does-not-exist"])).rejects.toThrow(
      "Command could not start",
    );

    await expect(
      shell.json(["bun", "-e", "console.log(JSON.stringify({ok:true}))"]),
    ).resolves.toEqual({ ok: true });
    await expect(shell.json(["bun", "-e", "process.exit(2)"])).rejects.toThrow(
      "Command failed before JSON could be parsed.",
    );
    await expect(shell.json(["bun", "-e", "console.log('nope')"])).rejects.toThrow(
      "Command stdout was not valid JSON.",
    );
    await expect(shell.exec([])).rejects.toThrow("shell.exec expects");
    await expect(shell.exec([""])).rejects.toThrow("shell.exec expects");
    await expect(shell.exec(["bun", 1 as never])).rejects.toThrow("shell.exec expects");

    await expect(new BunRigShellClass().exec(["echo", "fallback"])).resolves.toMatchObject({
      command: ["echo", "fallback"],
      stdout: "fallback\n",
      exitCode: 0,
    });
    await expect(
      new BunRigShellClass({ env: { RIG_SHELL_DEFAULT: "available" } }).exec([
        "bash",
        "-lc",
        'printf %s "$RIG_SHELL_DEFAULT"',
      ]),
    ).resolves.toMatchObject({ stdout: "available" });

    const independentlyBounded = await new BunRigShellClass({ maxOutputBytes: 4 }).exec([
      "bun",
      "-e",
      "process.stdout.write('abcdefgh')",
    ]);
    expect(independentlyBounded.stdout).toBe("abcd\n[rig: output truncated]");
  });

  test("exercises runtime support generation and truncation helpers", async () => {
    const home = await workspaces.create();
    const registry = join(home, "registry");
    const support = new RuntimeSupportClass({ homeDir: home });
    await support.ensure([registry]);
    expect(await readFile(join(registry, "tsconfig.json"), "utf8")).toContain("Generated by Rig");
    const runtimeSdk = await readFile(new RigPathsClass({ homeDir: home }).runtimeSdkPath, "utf8");
    expect(runtimeSdk).toContain("class RigManagedProcessClass");
    expect(runtimeSdk).toContain('detached: process.platform !== "win32"');
    expect(runtimeSdk).toContain("[rig: output truncated]");
    expect(runtimeSdk).toContain("^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$");
    const runtimeTypes = await readFile(
      new RigPathsClass({ homeDir: home }).runtimeTypesPath,
      "utf8",
    );
    expect(runtimeTypes).toContain("$(strings: TemplateStringsArray");
    expect(runtimeTypes).toContain("env: Env");
    expect(runtimeTypes).toContain("processEnv: NodeJS.ProcessEnv");
    expect(runtimeTypes).toContain("env?: Env");
    expect(runtimeTypes).toContain("setupDb?: (db: RigToolDatabase)");
    expect(runtimeTypes).toContain("kv: RigToolKvStore");
    expect(runtimeTypes).toContain("cache: RigToolCache");
    expect(runtimeTypes).toContain("log: RigToolLogger");
    expect(runtimeTypes).toContain("shell: RigShell");
    expect(runtimeTypes).toContain("collections: Collections");
    expect(runtimeTypes).toContain("collections?: Collections");
    await writeFile(join(registry, "tsconfig.json"), "{}\n", "utf8");
    await support.ensure([registry]);
    expect(await readFile(join(registry, "tsconfig.json"), "utf8")).toBe("{}\n");

    expect(
      await new RigOutputTruncatorClass({ maxBytes: 100, maxLines: 10 }).truncateData({ ok: true }),
    ).toEqual({ ok: true });
    const truncator = new RigOutputTruncatorClass({ maxBytes: 10, maxLines: 2 });
    expect(await truncator.truncateData(undefined)).toBeUndefined();
    const truncated = (await truncator.truncateData({ text: "a\nb\nc\nd" })) as {
      truncated: boolean;
      omittedLines: number;
      fullOutputPath: string;
      message: string;
    };
    expect(truncated.truncated).toBe(true);
    expect(truncated.omittedLines).toBeGreaterThan(0);
    expect(existsSync(truncated.fullOutputPath)).toBe(true);
    expect(truncated.message).toContain("Output truncated");

    const textTruncator = (
      truncator as unknown as {
        truncator: {
          truncate(value: string, options: { maxBytes: number; maxLines: number }): unknown;
        };
      }
    ).truncator;
    expect(textTruncator.truncate("", { maxBytes: 10, maxLines: 10 })).toMatchObject({
      totalBytes: 0,
      totalLines: 0,
      truncated: false,
    });
    expect(textTruncator.truncate("abcdef", { maxBytes: 3, maxLines: 10 })).toMatchObject({
      content: "abc",
      truncated: true,
    });
    const formatter = (truncator as unknown as { sizeFormatter: { format(bytes: number): string } })
      .sizeFormatter;
    expect(formatter.format(12)).toBe("12B");
    expect(formatter.format(2048)).toBe("2.0KB");
    expect(formatter.format(2 * 1024 * 1024)).toBe("2.0MB");
  });

  test("exercises creator, help, inspection, listing, schemas, SDK, and type helpers", async () => {
    const home = await workspaces.create();
    await new ToolCreatorClass({ homeDir: home }).create("sample");
    await expect(new ToolCreatorClass({ homeDir: home }).create("sample")).rejects.toThrow(
      "Tool already exists",
    );

    const renderer = new ToolHelpRendererClass();
    const loaded = await new ToolLoaderClass({ homeDir: home }).load("sample");
    const fullHelp = renderer.render(loaded.definition);
    expect(fullHelp).toContain("# sample");
    await expect(
      new ToolHelpServiceClass({ homeDir: home }).render("sample", "missing"),
    ).rejects.toThrow("Command not found: sample.missing");

    const command = loaded.definition.commands.example!;
    expect(
      renderer.render({
        ...loaded.definition,
        commands: { example: { ...command, examples: [] } },
      }),
    ).toContain("No examples declared.");
    expect(
      renderer.render({
        ...loaded.definition,
        commands: {
          example: {
            ...command,
            input: rig.z.object({ maybe: rig.z.string().optional() }),
            examples: undefined,
          },
        },
      }),
    ).toContain("No examples declared.");
    expect(
      renderer.render({
        ...loaded.definition,
        commands: {
          example: {
            ...command,
            input: null as never,
            output: null as never,
            examples: [{ title: "Scalar", text: "Scalar input", input: "two words" }],
          },
        },
      }),
    ).toContain("'two words'");
    expect(
      renderer.render({
        ...loaded.definition,
        commands: {
          example: {
            ...command,
            examples: [{ title: "Output only", text: "No input", output: { text: "done" } }],
          },
        },
      }),
    ).toContain("$ rig run sample.example");
    expect(
      (
        renderer as unknown as {
          renderCommand(tool: string, command: string, definition: unknown): string;
        }
      ).renderCommand("sample", "example", command),
    ).toContain("### sample.example");
    expect(
      new (await import("../tools/list")).CommandRunExampleRendererClass().render(
        "sample",
        "example",
        command,
      ),
    ).toContain("rig run sample.example");
    expect(
      (renderer as unknown as { renderExampleArgs(input: unknown): string }).renderExampleArgs({
        first: "two words",
        second: "ok",
      }),
    ).toBe("first='two words' second=ok");
    expect((renderer as unknown as { typeName(schema: unknown): string }).typeName(null)).toBe(
      "unknown",
    );
    expect(
      (renderer as unknown as { typeName(schema: unknown): string }).typeName({
        type: ["string", "number"],
      }),
    ).toBe("string | number");
    expect((renderer as unknown as { typeName(schema: unknown): string }).typeName({})).toBe(
      "unknown",
    );

    await writeTool(home, "metadata", simpleToolSource("metadata"));
    const inspector = new ToolInspectorClass({ homeDir: home });
    expect(await inspector.inspect("sample")).toMatchObject({ name: "sample" });
    expect(await inspector.inspect("metadata", "echo")).toMatchObject({ examples: [] });
    await expect(inspector.inspect("sample", "missing")).rejects.toThrow(
      "Command not found: sample.missing",
    );
    expect(
      new (await import("../tools/list")).ToolListServiceClass({ homeDir: home }).renderPlain({
        tools: [],
      }),
    ).toBe("No Rig tools found.");

    expect(schemaRenderer.toJsonSchema({})).toMatchObject({ type: "unknown" });
    expect(schemaRenderer.summary(z.object({ text: z.string() }))).toContain("text");
    expect(commandIds.from("tool", "command")).toBe("tool.command");

    const toolkit = createRigToolKit();
    await expect(toolkit.$`echo toolkit-ok`).resolves.toMatchObject({
      stdout: "toolkit-ok\n",
      exitCode: 0,
    });
    await expect(toolkit.run({ command: "bad" })).rejects.toThrow(
      "Command id must use <tool>.<command>",
    );
    await expect(toolkit.run({ tool: "bad", command: "" })).rejects.toThrow(
      "Command id must use <tool>.<command>",
    );
    await expect(
      createRigToolKit({ homeDir: home }).run({ command: "missing.echo" }),
    ).rejects.toThrow("Rig tool command failed: missing.echo");
    const builtArgs = toolkit
      .args()
      .raw("run")
      .flag("--yes")
      .flag("--no", false)
      .value("--count", 2)
      .value("--skip", null)
      .value("--missing", undefined)
      .values("--tag", ["a", "b"])
      .values("--empty", undefined)
      .toArray();
    expect(builtArgs).toEqual(["run", "--yes", "--count", "2", "--tag", "a", "--tag", "b"]);
    expect(args().raw("x").toArray()).toEqual(["x"]);

    const parent = join(home, "nested", "file.txt");
    await paths.ensureParent(parent);
    expect(existsSync(dirname(parent))).toBe(true);
    await writeFile(parent, "abc", "utf8");
    expect(paths.size(parent)).toBe(3);
    expect(paths.size(join(home, "missing"))).toBe(0);
    expect(paths.resolve(home, "~")).toBeTruthy();
    expect(paths.resolve(home, "~/file")).toContain("file");
    expect(paths.resolve(home, "relative")).toBe(join(home, "relative"));
    expect(paths.resolve(home, parent)).toBe(parent);
    expect(paths.home()).toBeTruthy();

    const definition = { name: "defined", description: "Defined.", commands: {} } as never;
    expect(defineTool(definition)).toBe(definition);
    const factory = () => definition;
    expect(defineTool(factory)).toBe(factory);
    expect(RigTool.define(factory)).toBe(factory);
    expect(rig.defineTool(definition)).toBe(definition);
  });

  test("exercises loader validation and load failures", async () => {
    const validator = new ToolDefinitionValidatorClass();
    const toolkit = createRigToolKit();
    const validCommand = {
      description: "Valid command.",
      input: toolkit.z.object({ text: toolkit.z.string() }),
      output: toolkit.z.object({ text: toolkit.z.string() }),
      examples: [{ title: "Example", text: "Example text." }],
      run: async ({ input: commandInput }: { input: { text: string } }) => ({
        text: commandInput.text,
      }),
    };
    const validTool = {
      name: "valid",
      description: "Valid tool.",
      env: toolkit.z.object({ API_TOKEN: toolkit.z.string() }),
      commands: { echo: validCommand },
    };
    expect(validator.validateToolDefinition(validTool, "valid")).toBe(validTool);
    expect(
      validator.validateToolDefinition(
        { description: "Derived name.", commands: { echo: validCommand } },
        "derived",
      ).name,
    ).toBe("derived");
    expect(() => validator.validateToolDefinition({}, undefined)).toThrow("Tool needs a name");
    expect(() => validator.validateToolName("")).toThrow("Invalid tool name");
    expect(() => validator.validateCommandName("")).toThrow("Invalid command name");

    const invalidDefinitions: Array<[unknown, string]> = [
      [null, "Tool default export must be an object"],
      [{}, "needs a description"],
      [{ name: "bad-name", description: "x", commands: {} }, "does not match its folder"],
      [{ name: "valid", description: "", commands: {} }, "needs a description"],
      [{ name: "valid", description: "x" }, "needs a commands object"],
      [{ ...validTool, setupDb: true }, "setupDb must be a function"],
      [{ ...validTool, env: true }, "needs a Zod schema for env"],
      [{ ...validTool, collections: true }, "needs a collections object"],
      [{ ...validTool, collections: { "../notes": {} } }, "Invalid collection name"],
      [{ name: "valid", description: "x", commands: {} }, "must define at least one command"],
      [{ ...validTool, commands: { "": validCommand } }, "Invalid command name"],
      [{ ...validTool, commands: { echo: null } }, "Invalid command valid.echo"],
      [
        { ...validTool, commands: { echo: { ...validCommand, description: "" } } },
        "needs a description",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, input: null } } },
        "needs a Zod schema for input",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, output: "not-a-schema" } } },
        "needs a Zod schema for output",
      ],
      [{ ...validTool, commands: { echo: { ...validCommand, examples: {} } } }, "Invalid examples"],
      [
        { ...validTool, commands: { echo: { ...validCommand, examples: [null] } } },
        "Invalid example",
      ],
      [
        {
          ...validTool,
          commands: { echo: { ...validCommand, examples: [{ text: "Missing title" }] } },
        },
        "Invalid example title",
      ],
      [
        {
          ...validTool,
          commands: { echo: { ...validCommand, examples: [{ title: "Missing text" }] } },
        },
        "Invalid example text",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, run: null } } },
        "needs a run function",
      ],
    ];

    for (const [definition, message] of invalidDefinitions) {
      expect(() => validator.validateToolDefinition(definition, "valid")).toThrow(message);
    }

    const home = await workspaces.create();
    const loader = new ToolLoaderClass({ homeDir: home });
    loader.validateCommandName("echo");
    await expect(loader.load("nonexistent")).rejects.toThrow("Tool not found");
    await expect(loader.loadCommand("valid", "Bad")).rejects.toThrow("Tool not found");

    await writeTool(home, "broken", "throw new Error('load failed');\n");
    await expect(loader.load("broken")).rejects.toThrow("Could not load tool broken");
    await writeTool(
      home,
      "factory",
      "export default () => { throw new Error('factory failed'); };\n",
    );
    await expect(loader.load("factory")).rejects.toThrow("Could not evaluate tool factory factory");
    await writeTool(home, "valid", simpleToolSource("valid"));
    const discoveredValid = await new ToolDiscoveryServiceClass({ homeDir: home }).find("valid");
    await expect(loader.loadDiscovered(discoveredValid)).resolves.toMatchObject({ name: "valid" });
    await expect(loader.loadCommand("valid", "missing")).rejects.toThrow(
      "Command not found: valid.missing",
    );
  });

  test("exercises runner input parsing, shell helpers, and error envelopes", async () => {
    const home = await workspaces.create();
    await writeTool(home, "sample", simpleToolSource("sample"));
    await writeTool(
      home,
      "scalar",
      `export default (rig) => rig.defineTool({
  name: "scalar",
  description: "Scalar test tool.",
  commands: {
    echo: rig.defineCommand({
      description: "Echo scalar.",
      input: rig.z.string(),
      output: rig.z.string(),
      run: async ({ input }) => input,
    }),
  },
});
`,
    );
    await writeTool(
      home,
      "writer",
      `export default (rig) => rig.defineTool({
  name: "writer",
  description: "Writer test tool.",
  commands: {
    save: rig.defineCommand({
      description: "Save text.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
    );
    await writeTool(
      home,
      "sheller",
      `export default (rig) => rig.defineTool({
  name: "sheller",
  description: "Shell test tool.",
  commands: {
    blocked: rig.defineCommand({
      description: "Blocked shell.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => {
        await rig.shell.exec(["bun", "-e", "console.log('blocked')"]);
        return { ok: true };
      },
    }),
    exec: rig.defineCommand({
      description: "Allowed shell exec.",
      input: rig.z.object({}),
      output: rig.z.object({ text: rig.z.string() }),
      run: async () => {
        const result = await rig.shell.exec(["bun", "-e", "console.log('ok')"]);
        return { text: result.stdout.trim() };
      },
    }),
    json: rig.defineCommand({
      description: "Allowed shell JSON.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => await rig.shell.json(["bun", "-e", "console.log(JSON.stringify({ok:true}))"]),
    }),
  },
});
`,
    );
    await writeTool(
      home,
      "bad-output",
      `export default (rig) => rig.defineTool({
  name: "bad-output",
  description: "Bad output tool.",
  commands: {
    fail: rig.defineCommand({
      description: "Return wrong output.",
      input: rig.z.object({}),
      output: rig.z.object({ text: rig.z.string() }),
      run: async () => ({ text: 123 }),
    }),
  },
});
`,
    );
    await writeTool(
      home,
      "thrower",
      `export default (rig) => rig.defineTool({
  name: "thrower",
  description: "Throwing tool.",
  commands: {
    string: rig.defineCommand({
      description: "Throw a string.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => { throw "boom"; },
    }),
    syntax: rig.defineCommand({
      description: "Throw an unexpected syntax error.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => { throw new SyntaxError("tool bug"); },
    }),
  },
});
`,
    );

    const runner = new ToolRunnerClass({ homeDir: home });
    await expect(runner.run("sample", "echo", { homeDir: home })).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { text: "default" } },
    });
    await expect(
      runner.run("sample", "echo", { homeDir: home, args: ['{"text":"json"}'] }),
    ).resolves.toMatchObject({ envelope: { data: { text: "json" } } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, args: ["text=key-value"] }),
    ).resolves.toMatchObject({ envelope: { data: { text: "key-value" } } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, args: ["two words"], dryRun: true }),
    ).resolves.toMatchObject({
      envelope: { data: { commandLine: "rig run sample.echo 'two words'" } },
    });

    const inputPath = join(home, "input.json");
    await writeFile(inputPath, '{"text":"file"}', "utf8");
    await expect(
      runner.run("sample", "echo", { homeDir: home, inputFile: inputPath }),
    ).resolves.toMatchObject({ envelope: { data: { text: "file" } } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, input: '{"text":"input"}' }),
    ).resolves.toMatchObject({ envelope: { data: { text: "input" } } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, input: "{bad" }),
    ).resolves.toMatchObject({ exitCode: 1, envelope: { errors: [{ code: "INPUT_ERROR" }] } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, input: "{}", args: ["x"] }),
    ).resolves.toMatchObject({ exitCode: 1, envelope: { errors: [{ code: "INPUT_ERROR" }] } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, args: ["=x"] }),
    ).resolves.toMatchObject({ exitCode: 1, envelope: { errors: [{ code: "INPUT_ERROR" }] } });
    await expect(
      runner.run("sample", "echo", { homeDir: home, args: ["a", "b"] }),
    ).resolves.toMatchObject({ exitCode: 1, envelope: { errors: [{ code: "INPUT_ERROR" }] } });

    await expect(
      runner.run("scalar", "echo", { homeDir: home, args: ["abc"] }),
    ).resolves.toMatchObject({ envelope: { data: "abc" } });
    await expect(
      runner.run("scalar", "echo", { homeDir: home, args: ["123"] }),
    ).resolves.toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "VALIDATION_ERROR" }] },
    });
    await expect(
      runner.run("scalar", "echo", { homeDir: home, args: ["a", "b"] }),
    ).resolves.toMatchObject({ exitCode: 1, envelope: { errors: [{ code: "INPUT_ERROR" }] } });

    await expect(
      runner.run("writer", "save", { homeDir: home, args: ["text=hi"] }),
    ).resolves.toMatchObject({ exitCode: 0, envelope: { data: { ok: true } } });

    await expect(runner.run("sheller", "blocked", { homeDir: home })).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { ok: true } },
    });
    await expect(runner.run("sheller", "exec", { homeDir: home })).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { text: "ok" } },
    });
    await expect(runner.run("sheller", "json", { homeDir: home })).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { ok: true } },
    });
    await expect(runner.run("bad-output", "fail", { homeDir: home })).resolves.toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "OUTPUT_VALIDATION_ERROR" }] },
    });
    await expect(runner.run("thrower", "string", { homeDir: home })).resolves.toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "INTERNAL_ERROR", message: "boom" }] },
    });
    await expect(runner.run("thrower", "syntax", { homeDir: home })).resolves.toMatchObject({
      exitCode: 1,
      envelope: { errors: [{ code: "INTERNAL_ERROR", message: "tool bug" }] },
    });
  });

  test("exercises typecheck success, all-tools mode, missing tools, and parser diagnostics", async () => {
    const home = await workspaces.create();
    await new ToolCreatorClass({ homeDir: home }).create("sample");
    const service = new ToolTypecheckServiceClass({ homeDir: home });
    const all = await service.typecheck();
    expect(all.ok).toBe(true);
    expect(all.checked).toHaveLength(1);
    await expect(service.typecheck("missing")).rejects.toThrow("Tool not found: missing");

    const privateService = service as unknown as {
      runTypeScript(path: string): { stdout: string; exitCode: number };
      parseHost(): { onUnRecoverableConfigFileDiagnostic(diagnostic: unknown): void };
    };
    expect(() => privateService.runTypeScript(join(home, "missing-tsconfig.json"))).toThrow(
      "Unable to parse generated Rig tool tsconfig.",
    );
    expect(() =>
      privateService.parseHost().onUnRecoverableConfigFileDiagnostic({
        category: 1,
        code: 1000,
        file: undefined,
        length: 0,
        start: 0,
        messageText: "bad config",
      }),
    ).toThrow("Unable to parse generated Rig tool tsconfig.");
  });

  test("type-checks v2 env and collection context from a plain command definition", async () => {
    const home = await workspaces.create();
    const source = `// rig:tool-api-version 2
export default (rig: RigToolKit) => rig.defineTool({
  description: "Type-check the complete v2 authoring contract.",
  env: rig.z.object({ TOKEN: rig.z.string() }),
  collections: {
    notes: { schema: rig.z.object({ title: rig.z.string() }) },
  },
  commands: (command) => ({
    add: command({
      description: "Add a note.",
      input: rig.z.object({ title: rig.z.string() }),
      output: rig.z.object({ title: rig.z.string(), token: rig.z.string() }),
      run: async ({ input, env, collections }) => {
        const entry = await collections.notes.create({ data: { title: input.title } });
        return { title: entry.data.title, token: env.TOKEN };
      },
    }),
  }),
});
`;
    await writeTool(home, "contract", source);

    const typecheck = await new ToolTypecheckServiceClass({ homeDir: home }).typecheck("contract");
    expect(typecheck).toMatchObject({ ok: true, exitCode: 0 });
    const loaded = await new ToolLoaderClass({ homeDir: home }).loadDefinition("contract");
    expect(loaded.definition.name).toBe("contract");
  });

  test("supports injected tool API migration collaborators", async () => {
    const home = await workspaces.create();
    await new ToolCreatorClass({ homeDir: home }).create("current");
    let source = "// rig:tool-api-version 2\n";
    const service = new ToolApiMigrationServiceClass(
      { homeDir: home },
      {
        discovery: new ToolDiscoveryServiceClass({ homeDir: home }),
        readSource: async () => source,
      },
    );

    await expect(service.inspect({ visibleFromPath: home })).resolves.toMatchObject({
      ready: true,
      migrations: [],
      unsupported: [],
    });

    source = "// rig:tool-api-version 999999999999999999999999\n";
    await expect(service.inspect()).resolves.toMatchObject({
      ready: false,
      migrations: [{ fromVersion: 1, toVersion: 2 }],
    });

    expect(
      service.renderAgentInstructions({
        report: {
          currentVersion: 2,
          ready: false,
          migrations: [],
          unsupported: [{ name: "future", path: "/future", fromVersion: 3, toVersion: 2 }],
        },
      }),
    ).toContain("newer API than this Rig installation supports");

    const bunDiscovery = new ToolDiscoveryServiceClass({ homeDir: home });
    vi.spyOn(bunDiscovery, "discover").mockResolvedValue([
      {
        name: "bun-source",
        registryKind: "base",
        registryPath: home,
        toolDir: home,
        toolPath: join(home, "index.rig.ts"),
      },
    ]);
    vi.stubGlobal("Bun", {
      file: () => ({ text: async () => "// rig:tool-api-version 2\n" }),
    });
    await expect(
      new ToolApiMigrationServiceClass({ homeDir: home }, { discovery: bunDiscovery }).inspect(),
    ).resolves.toMatchObject({ ready: true });
  });
});
