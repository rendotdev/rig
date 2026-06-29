import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { RigConfigStore } from "../src/config/config";
import { RigPaths } from "../src/config/paths";
import { RigConfigDefaults } from "../src/config/schema";
import { DevLinkService } from "../src/dev/dev-link";
import { ErrorCodes } from "../src/errors/codes";
import { RigError, RigErrors } from "../src/errors/RigError";
import { ToolDiscoveryService } from "../src/registry/discover";
import { RegistryConfigService } from "../src/registry/registry";
import { RigPackageRoot } from "../src/runtime/package-root";
import { BunRigShell } from "../src/runtime/shell";
import { RuntimeSupport } from "../src/runtime/support";
import { RigOutputTruncator } from "../src/runtime/truncation";
import { ToolCreator } from "../src/tools/create";
import { ToolHelpRenderer, ToolHelpService } from "../src/tools/help";
import { ToolInspector } from "../src/tools/inspect";
import { ToolDefinitionValidator, ToolLoader } from "../src/tools/loader";
import { ToolRunner } from "../src/tools/run";
import { SchemaRenderer } from "../src/tools/schema";
import {
  args,
  createRigToolKit,
  defineTool,
  input,
  output,
  paths,
  RigTool,
  rig,
} from "../src/tools/sdk";
import { CommandIds, RigSchemaRoleSymbol } from "../src/tools/types";
import { ToolTypecheckService } from "../src/tools/typecheck";

class TempWorkspaceStore {
  private readonly paths: string[] = [];
  private readonly originalEnv = { ...process.env };
  private readonly originalArgv = [...process.argv];
  private readonly originalExecPath = process.execPath;

  async create(prefix = "rig-coverage-"): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
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
  const toolDir = join(home, ".rig", "tools", name);
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
    ${command}: rig.command({
      description: "Echo text.",
      input: rig.input({ text: rig.z.string().default("default") }),
      output: rig.output({ text: rig.z.string() }),
      run: async ({ input }) => ({ text: input.text }),
    }),
  },
});
`;
}

describe("coverage support", () => {
  test("exercises config reads, writes, defaults, and path helpers", async () => {
    const home = await workspaces.create();
    const pathsForHome = new RigPaths({ homeDir: home });
    const configStore = new RigConfigStore({ homeDir: home });

    await expect(configStore.read()).rejects.toThrow("Could not read config");
    await mkdir(pathsForHome.rigDir, { recursive: true });
    await writeFile(pathsForHome.configPath, "{ nope", "utf8");
    await expect(configStore.read()).rejects.toThrow("Config is not valid JSON");
    await writeFile(pathsForHome.configPath, '{"version":2}', "utf8");
    await expect(configStore.read()).rejects.toThrow("Rig config is invalid");
    await expect(configStore.write({ version: 2 } as never)).rejects.toThrow(
      "Rig config is invalid",
    );

    const config = RigConfigDefaults.create();
    config.customRegistries = ["~/custom-tools", join(home, "absolute-tools")];
    await configStore.write(config);
    expect(await configStore.read()).toEqual(config);
    expect(configStore.resolvedBaseRegistry({ ...config, baseRegistryDir: "" } as never)).toBe(
      join(home, ".rig", "tools"),
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

    const defaultPaths = new RigPaths();
    expect(defaultPaths.homeDir).toBeTruthy();
    expect(pathsForHome.expandTilde("~")).toBe(home);
    expect(pathsForHome.expandTilde("~/tools")).toBe(join(home, "tools"));
    expect(pathsForHome.expandTilde("relative")).toBe("relative");
    expect(pathsForHome.resolve("relative")).toBe(resolve(process.cwd(), "relative"));
    expect(pathsForHome.resolve(join(home, "file"))).toBe(join(home, "file"));
    expect(pathsForHome.defaultBaseRegistryDir).toBe("~/.rig/tools");
    expect(pathsForHome.parentDir(join(home, "child", "file.txt"))).toBe(join(home, "child"));
  });

  test("exercises registry configuration and discovery edges", async () => {
    const home = await workspaces.create();
    const service = new RegistryConfigService({ homeDir: home });
    const pathsForHome = new RigPaths({ homeDir: home });

    const listed = await service.list();
    expect(listed.baseRegistryDir).toBe(pathsForHome.resolve("~/.rig/tools"));
    await expect(service.add("~/.rig/tools")).rejects.toThrow(
      "The base registry is already configured.",
    );

    const custom = join(home, "custom");
    await service.add(custom);
    const addedTwice = await service.add(custom);
    expect(addedTwice.customRegistries).toEqual([custom]);
    await expect(service.remove(join(home, "missing"))).rejects.toThrow(
      "Registry is not configured",
    );

    const discovery = new ToolDiscoveryService({ homeDir: home });
    await expect(discovery.find("missing")).rejects.toThrow("Tool not found: missing");

    await mkdir(join(home, ".rig", "tools", "empty"), { recursive: true });
    await mkdir(join(home, ".rig", "tools", "multi"), { recursive: true });
    await writeFile(join(home, ".rig", "tools", "multi", "index.rig.ts"), "export default {};\n");
    await writeFile(join(home, ".rig", "tools", "multi", "index.rig.tsx"), "export default {};\n");
    await writeFile(join(home, ".rig", "tools", "not-a-dir"), "x\n");

    await expect(discovery.discover()).rejects.toThrow("multiple Rig entry files");

    await rm(join(home, ".rig", "tools", "multi", "index.rig.tsx"));
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
    const serviceFromCwd = new DevLinkService({ homeDir: home });
    expect((await serviceFromCwd.status({ binDir })).repoRoot).toBe(process.cwd());

    const service = new DevLinkService({ homeDir: home, repoRoot });
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

    await expect(new DevLinkService({ homeDir: home, repoRoot: home }).status()).rejects.toThrow(
      "Run dev link from the Rig repository root.",
    );
  });

  test("exercises error conversion and exported codes", () => {
    const rigError = new RigError("INPUT_ERROR", "bad", { field: "x" });
    expect(RigErrors.from(rigError)).toBe(rigError);
    expect(RigErrors.from(new Error("plain"))).toMatchObject({
      code: "INPUT_ERROR",
      message: "plain",
    });
    expect(RigErrors.from("string failure")).toMatchObject({
      code: "INPUT_ERROR",
      message: "string failure",
    });
    expect(ErrorCodes.SHELL_ERROR).toBe("SHELL_ERROR");
  });

  test("exercises package-root detection modes", async () => {
    const envRoot = await workspaces.create();
    process.env.RIG_PACKAGE_ROOT = envRoot;
    expect(RigPackageRoot.find(import.meta.url)).toBe(envRoot);
    expect(RigPackageRoot.packageFile(import.meta.url, "dist", "rig.js")).toBe(
      join(envRoot, "dist", "rig.js"),
    );
    delete process.env.RIG_PACKAGE_ROOT;

    const repoRoot = await workspaces.create();
    await mkdir(join(repoRoot, "src"), { recursive: true });
    const cliPath = join(repoRoot, "src", "cli.ts");
    await writeFile(cliPath, "", "utf8");
    process.argv[1] = cliPath;
    expect(RigPackageRoot.find(import.meta.url)).toBe(await realpath(repoRoot));

    process.argv[1] = join(repoRoot, "missing.ts");
    await mkdir(join(repoRoot, "dist"), { recursive: true });
    const execPath = join(repoRoot, "dist", "rig.js");
    await writeFile(execPath, "", "utf8");
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
    expect(RigPackageRoot.find(import.meta.url)).toBe(await realpath(repoRoot));

    Object.defineProperty(process, "execPath", {
      value: join(repoRoot, "bin", "bun"),
      configurable: true,
    });
    process.argv[1] = join(repoRoot, "bin", "script");
    expect(RigPackageRoot.find("file:///%7EBUN/root")).toBe(join(repoRoot, "bin"));
    expect(
      (
        RigPackageRoot as unknown as { fromEntrypoint(entrypoint: undefined): string | undefined }
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
    expect(RigPackageRoot.find(import.meta.url)).toBe(await realpath(symlinkRoot));
  });

  test("exercises shell execution, JSON parsing, validation, truncation, and timeouts", async () => {
    const shell = new BunRigShell({ timeoutMs: 5_000, maxOutputBytes: 20 });
    const success = await shell.exec(["bun", "-e", "console.log('hello')"], {
      cwd: process.cwd(),
      env: { RIG_SHELL_TEST: "1" },
      maxOutputBytes: 100,
    });
    expect(success).toMatchObject({ exitCode: 0, stdout: "hello\n" });

    const trimmed = await shell.exec([
      "bun",
      "-e",
      "console.log('x'.repeat(100)); console.error('y'.repeat(100))",
    ]);
    expect(trimmed.stdout).toContain("[rig: output truncated]");
    expect(trimmed.stderr).toContain("[rig: output truncated]");

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
    await expect(
      shell.exec(["bun", "-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 1 }),
    ).rejects.toThrow("Command timed out");

    expect(
      (
        shell as unknown as { trimOutput(value: string, maxOutputBytes?: number): string }
      ).trimOutput("abc", 0),
    ).toBe("abc");
    await expect(
      (shell as unknown as { readStream(stream: Readable): Promise<string> }).readStream(
        Readable.from(["a", Buffer.from("b")]),
      ),
    ).resolves.toBe("ab");
  });

  test("exercises runtime support generation and truncation helpers", async () => {
    const home = await workspaces.create();
    const registry = join(home, "registry");
    const support = new RuntimeSupport({ homeDir: home });
    await support.ensure([registry]);
    expect(await readFile(join(registry, "tsconfig.json"), "utf8")).toContain("Generated by Rig");
    await writeFile(join(registry, "tsconfig.json"), "{}\n", "utf8");
    await support.ensure([registry]);
    expect(await readFile(join(registry, "tsconfig.json"), "utf8")).toBe("{}\n");

    expect(
      await new RigOutputTruncator({ maxBytes: 100, maxLines: 10 }).truncateData({ ok: true }),
    ).toEqual({ ok: true });
    const truncator = new RigOutputTruncator({ maxBytes: 10, maxLines: 2 });
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
    await new ToolCreator({ homeDir: home }).create("sample");
    await expect(new ToolCreator({ homeDir: home }).create("sample")).rejects.toThrow(
      "Tool already exists",
    );

    const renderer = new ToolHelpRenderer();
    const loaded = await new ToolLoader({ homeDir: home }).load("sample");
    const fullHelp = renderer.render(loaded.definition);
    expect(fullHelp).toContain("# sample");
    await expect(
      new ToolHelpService({ homeDir: home }).render("sample", "missing"),
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
            input: rig.input({ maybe: rig.z.string().optional() }),
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
    ).toContain('Output: {"text":"done"}');
    expect(
      (
        renderer as unknown as {
          renderCommand(tool: string, command: string, definition: unknown): string;
        }
      ).renderCommand("sample", "example", command),
    ).toContain("### sample.example");
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
    const inspector = new ToolInspector({ homeDir: home });
    expect(await inspector.inspect("sample")).toMatchObject({ name: "sample" });
    expect(await inspector.inspect("metadata", "echo")).toMatchObject({ examples: [] });
    await expect(inspector.inspect("sample", "missing")).rejects.toThrow(
      "Command not found: sample.missing",
    );
    expect(
      new (await import("../src/tools/list")).ToolListService({ homeDir: home }).renderPlain({
        tools: [],
      }),
    ).toBe("No tools found.");

    expect(SchemaRenderer.toJsonSchema({})).toMatchObject({ type: "unknown" });
    expect(SchemaRenderer.summary(z.object({ text: z.string() }))).toContain("text");
    expect(CommandIds.from("tool", "command")).toBe("tool.command");

    const toolkit = createRigToolKit();
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

    const inputSchema = input({ text: rig.z.string() });
    expect(input(inputSchema)[RigSchemaRoleSymbol]).toBe("input");
    expect(output(z.object({ ok: z.boolean() }))[RigSchemaRoleSymbol]).toBe("output");
    const definition = { name: "defined", description: "Defined.", commands: {} } as never;
    expect(defineTool(definition)).toBe(definition);
    const factory = () => definition;
    expect(defineTool(factory)).toBe(factory);
    expect(RigTool.define(factory)).toBe(factory);
    expect(rig.defineTool(definition)).toBe(definition);
  });

  test("exercises loader validation and load failures", async () => {
    const validator = new ToolDefinitionValidator();
    const toolkit = createRigToolKit();
    const validCommand = {
      description: "Valid command.",
      input: toolkit.input({ text: toolkit.z.string() }),
      output: toolkit.output({ text: toolkit.z.string() }),
      examples: [{ title: "Example", text: "Example text." }],
      run: async ({ input: commandInput }: { input: { text: string } }) => ({
        text: commandInput.text,
      }),
    };
    const validTool = {
      name: "valid",
      description: "Valid tool.",
      commands: { echo: validCommand },
    };
    expect(validator.validateToolDefinition(validTool, "valid")).toBe(validTool);
    expect(() => validator.validateToolName("Bad")).toThrow("Invalid tool name");
    expect(() => validator.validateCommandName("Bad")).toThrow("Invalid command name");

    const invalidDefinitions: Array<[unknown, string]> = [
      [null, "Tool default export must be an object"],
      [{}, "Tool needs a name"],
      [{ name: "bad-name", description: "x", commands: {} }, "does not match its folder"],
      [{ name: "valid", description: "", commands: {} }, "needs a description"],
      [{ name: "valid", description: "x" }, "needs a commands object"],
      [{ name: "valid", description: "x", commands: {} }, "must define at least one command"],
      [{ ...validTool, commands: { Bad: validCommand } }, "Invalid command name"],
      [{ ...validTool, commands: { echo: null } }, "Invalid command valid.echo"],
      [
        { ...validTool, commands: { echo: { ...validCommand, description: "" } } },
        "needs a description",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, input: null } } },
        "needs a Rig input schema",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, input: z.object({}) } } },
        "needs a Rig input schema",
      ],
      [
        { ...validTool, commands: { echo: { ...validCommand, output: toolkit.input({}) } } },
        "needs a Rig output schema",
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
    const loader = new ToolLoader({ homeDir: home });
    loader.validateCommandName("echo");
    await expect(loader.load("Bad")).rejects.toThrow("Invalid tool name");
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
    echo: rig.command({
      description: "Echo scalar.",
      input: rig.input(rig.z.string()),
      output: rig.output(rig.z.string()),
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
    save: rig.command({
      description: "Save text.",
      input: rig.input({ text: rig.z.string() }),
      output: rig.output({ ok: rig.z.boolean() }),
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
    blocked: rig.command({
      description: "Blocked shell.",
      input: rig.input({}),
      output: rig.output({ ok: rig.z.boolean() }),
      run: async ({ shell }) => {
        await shell.exec(["bun", "-e", "console.log('blocked')"]);
        return { ok: true };
      },
    }),
    exec: rig.command({
      description: "Allowed shell exec.",
      input: rig.input({}),
      output: rig.output({ text: rig.z.string() }),
      run: async ({ shell }) => {
        const result = await shell.exec(["bun", "-e", "console.log('ok')"]);
        return { text: result.stdout.trim() };
      },
    }),
    json: rig.command({
      description: "Allowed shell JSON.",
      input: rig.input({}),
      output: rig.output({ ok: rig.z.boolean() }),
      run: async ({ shell }) => await shell.json(["bun", "-e", "console.log(JSON.stringify({ok:true}))"]),
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
    fail: rig.command({
      description: "Return wrong output.",
      input: rig.input({}),
      output: rig.output({ text: rig.z.string() }),
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
    string: rig.command({
      description: "Throw a string.",
      input: rig.input({}),
      output: rig.output({ ok: rig.z.boolean() }),
      run: async () => { throw "boom"; },
    }),
  },
});
`,
    );

    const runner = new ToolRunner({ homeDir: home });
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
      envelope: { errors: [{ code: "INPUT_ERROR", message: "boom" }] },
    });
  });

  test("exercises typecheck success, all-tools mode, missing tools, and parser diagnostics", async () => {
    const home = await workspaces.create();
    await new ToolCreator({ homeDir: home }).create("sample");
    const service = new ToolTypecheckService({ homeDir: home });
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
});
