import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { RigE2EHarnessClass, rigE2EHarnessFactory } from "./harness";

type SuccessEnvelope<T> = {
  data: T;
  errors: [];
  pipe?: Record<string, unknown>;
};

type ErrorEnvelope = {
  data: null;
  errors: Array<{ code: string; message: string; details?: unknown }>;
};

const LifecycleToolSource = `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: "lifecycle",
  description: "Exercise Rig end to end.",
  commands: {
    echo: rig.defineCommand({
      description: "Echo structured input.",
      input: rig.z.object({
        text: rig.z.string(),
        count: rig.z.coerce.number().int().positive().default(1),
      }),
      output: rig.z.object({
        text: rig.z.string(),
        count: rig.z.number(),
        repeated: rig.z.string(),
        meta: rig.z.object({ label: rig.z.string() }),
      }),
      examples: [{
        title: "Echo text",
        text: "Echo text a chosen number of times.",
        input: { text: "hello", count: 2 },
        output: { text: "hello", count: 2, repeated: "hellohello", meta: { label: "hello:2" } },
      }],
      run: async (context) => ({
        text: context.input.text,
        count: context.input.count,
        repeated: context.input.text.repeat(context.input.count),
        meta: { label: context.input.text + ":" + context.input.count },
      }),
    }),
  },
});

export default tool;
`;

const EnvToolSource = `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: "secrets",
  description: "Exercise environment management.",
  env: rig.z.object({
    TOKEN: rig.z.string().min(3),
    LABEL: rig.z.string().optional(),
  }),
  commands: {
    read: rig.defineCommand({
      description: "Read configured environment.",
      input: rig.z.object({}),
      output: rig.z.object({ token: rig.z.string(), label: rig.z.string().optional() }),
      run: async (context) => ({ token: context.env.TOKEN, label: context.env.LABEL }),
    }),
  },
});

export default tool;
`;

describe("built Rig CLI lifecycle", () => {
  let rig: RigE2EHarnessClass;

  beforeEach(async () => {
    rig = await rigE2EHarnessFactory.create();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  test("initializes from the default status and reports a healthy isolated setup", async () => {
    const status = await rig.run();
    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout).toContain("Rig is ready.");
    expect(status.stdout).toContain(`Config:        ${join(rig.rigHomeDir, "rig", "rig.json")}`);
    expect(status.stdout).toContain("Tools found:   0");

    const init = await rig.run({ args: ["init"] });
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("Rig is ready.");

    const doctor = await rig.run({ args: ["doctor"] });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("Rig doctor");
    expect(doctor.stdout).toContain("Status: OK");
    expect(doctor.stdout).toContain("Tools:         0");
  });

  test("prints deterministic config paths and valid config and registry JSON", async () => {
    const path = await rig.run({ args: ["config", "path"] });
    expect(path.exitCode).toBe(0);
    expect(path.stdout.trim()).toBe(join(rig.rigHomeDir, "rig", "rig.json"));

    const show = await rig.run({ args: ["config", "show"] });
    expect(show.exitCode).toBe(0);
    expect(show.json<{ baseRegistryDir: string; customRegistries: string[] }>()).toEqual({
      version: 1,
      baseRegistryDir: "~/rig/tools",
      customRegistries: [],
      cronJobs: [],
    });

    const registries = await rig.run({ args: ["registry", "list"] });
    expect(registries.exitCode).toBe(0);
    expect(registries.json()).toEqual({
      baseRegistryDir: join(rig.rigHomeDir, "rig", "tools"),
      customRegistries: [],
      registries: [{ kind: "base", path: join(rig.rigHomeDir, "rig", "tools") }],
    });
  });

  test("creates, lists, documents, inspects, and locates a tool", async () => {
    const created = await rig.run({ args: ["create", "sample"] });
    expect(created.exitCode).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.stdout).toContain("Created tool sample");
    expect(created.stdout).toContain("rig run sample.example test");

    const list = await rig.run({ args: ["list"] });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("sample # Describe what this tool does.");
    expect(list.stdout).toContain("rig run sample.example text=example");

    const listJson = await rig.run({ args: ["list", "--json"] });
    const listed = listJson.json<{
      tools: Array<{ name: string; commands: Array<{ id: string }> }>;
    }>();
    expect(listed.tools[0]?.name).toBe("sample");
    expect(listed.tools[0]?.commands[0]?.id).toBe("sample.example");

    const help = await rig.run({ args: ["help", "sample.example"] });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("sample.example");
    expect(help.stdout).toContain("Example command");

    const inspect = await rig.run({ args: ["inspect", "sample.example"] });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json<{ id: string; tool: string; command: string }>()).toMatchObject({
      id: "sample.example",
      tool: "sample",
      command: "example",
    });

    const edit = await rig.run({ args: ["edit", "sample"] });
    expect(edit.exitCode).toBe(0);
    expect(edit.stdout.trim()).toBe(join(rig.rigHomeDir, "rig", "tools", "sample", "index.rig.ts"));
  });

  test("runs positional, key-value, JSON, and input-file payloads as subprocesses", async () => {
    await rig.run({ args: ["init"] });
    await rig.writeTool({ name: "lifecycle", source: LifecycleToolSource });

    const positional = await rig.run({ args: ["run", "lifecycle.echo", "hello", "2"] });
    expect(positional.exitCode).toBe(0);
    expect(positional.stderr).toBe("");
    expect(positional.json<SuccessEnvelope<{ repeated: string }>>()).toMatchObject({
      data: { repeated: "hellohello" },
      errors: [],
    });

    const keyValue = await rig.run({
      args: ["run", "lifecycle.echo", "text=keys", "count=3"],
    });
    expect(keyValue.json<SuccessEnvelope<{ repeated: string }>>().data.repeated).toBe(
      "keyskeyskeys",
    );

    const json = await rig.run({
      args: ["run", "lifecycle.echo", "--input", JSON.stringify({ text: "json", count: 2 })],
    });
    expect(json.json<SuccessEnvelope<{ meta: { label: string } }>>().data.meta.label).toBe(
      "json:2",
    );

    const inputPath = await rig.writeProjectFile(
      "fixtures/input.json",
      `${JSON.stringify({ text: "file", count: 2 })}\n`,
    );
    const inputFile = await rig.run({
      args: ["run", "lifecycle.echo", "--input-file", inputPath],
    });
    expect(inputFile.json<SuccessEnvelope<{ repeated: string }>>().data.repeated).toBe("filefile");
  });

  test("supports dry-run, query, named output, and piped references", async () => {
    await rig.run({ args: ["init"] });
    await rig.writeTool({ name: "lifecycle", source: LifecycleToolSource });

    const dryRun = await rig.run({
      args: ["run", "lifecycle.echo", "dry", "2", "--dry-run"],
    });
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.json<SuccessEnvelope<Record<string, unknown>>>().data).toMatchObject({
      dryRun: true,
      wouldRun: false,
      id: "lifecycle.echo",
      input: { text: "dry", count: 2 },
    });

    const query = await rig.run({
      args: ["run", "lifecycle.echo", "query", "3", "--query", "data.meta.label"],
    });
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toBe("query:3\n");

    const first = await rig.run({
      args: ["run", "lifecycle.echo", "first", "2", "--as", "first"],
    });
    const firstEnvelope = first.json<SuccessEnvelope<{ text: string }>>();
    expect(firstEnvelope.pipe).toMatchObject({ first: { text: "first" } });

    const second = await rig.run({
      args: ["run", "lifecycle.echo", "@first.text", "1", "--pipe"],
      stdin: first.stdout,
    });
    expect(second.exitCode).toBe(0);
    expect(second.json<SuccessEnvelope<{ text: string }>>().data.text).toBe("first");
  });

  test("adds, reads, validates, and removes schema-backed environment values", async () => {
    await rig.run({ args: ["init"] });
    await rig.writeTool({ name: "secrets", source: EnvToolSource });

    const invalid = await rig.run({ args: ["env", "secrets", "TOKEN=x"] });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("TOOL_INVALID: Tool secrets env would be invalid.");

    const added = await rig.run({ args: ["env", "secrets", "TOKEN=secret", "LABEL=local dev"] });
    expect(added.exitCode).toBe(0);
    expect(added.json<{ updated: boolean; updatedKeys: string[] }>()).toMatchObject({
      updated: true,
      updatedKeys: ["LABEL", "TOKEN"],
    });

    const run = await rig.run({ args: ["run", "secrets.read"] });
    expect(run.json<SuccessEnvelope<{ token: string; label?: string }>>().data).toEqual({
      token: "secret",
      label: "local dev",
    });

    const removedOptional = await rig.run({ args: ["env", "secrets", "remove", "LABEL"] });
    expect(removedOptional.exitCode).toBe(0);
    expect(removedOptional.json<{ removedKeys: string[] }>().removedKeys).toEqual(["LABEL"]);

    const removeRequired = await rig.run({ args: ["env", "secrets", "remove", "TOKEN"] });
    expect(removeRequired.exitCode).toBe(1);
    expect(removeRequired.stderr).toContain("TOOL_INVALID: Tool secrets env would be invalid.");

    const badAssignment = await rig.run({ args: ["env", "secrets", "NOT_AN_ASSIGNMENT"] });
    expect(badAssignment.exitCode).toBe(1);
    expect(badAssignment.stderr).toContain("INPUT_ERROR: Env assignment must use KEY=VALUE");
  });

  test("type-checks valid tools and returns diagnostics and exit code 2 for invalid tools", async () => {
    await rig.run({ args: ["init"] });
    const toolPath = await rig.writeTool({ name: "lifecycle", source: LifecycleToolSource });

    const valid = await rig.run({ args: ["typecheck", "lifecycle"], timeoutMs: 30_000 });
    expect(valid.exitCode).toBe(0);
    expect(valid.json<{ ok: boolean; checked: string[] }>()).toMatchObject({
      ok: true,
      checked: [toolPath],
    });

    await rig.write(toolPath, `${LifecycleToolSource}\nconst broken: string = 42;\n`);
    const invalid = await rig.run({ args: ["typecheck", "lifecycle"], timeoutMs: 30_000 });
    expect(invalid.exitCode).toBe(2);
    const diagnostics = invalid.json<{ ok: boolean; exitCode: number; stdout: string }>();
    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.exitCode).toBe(2);
    expect(diagnostics.stdout).toContain("Type 'number' is not assignable to type 'string'");
  });

  test("removes tools and reports subsequent lookup failures", async () => {
    await rig.run({ args: ["create", "temporary"] });
    const removed = await rig.run({ args: ["remove", "temporary"] });
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("Removed tool temporary");

    const edit = await rig.run({ args: ["edit", "temporary"] });
    expect(edit.exitCode).toBe(1);
    expect(edit.stderr).toContain("TOOL_NOT_FOUND: Tool not found: temporary");
  });

  test("rejects unsafe identifiers without writing outside the registry", async () => {
    await rig.run({ args: ["init"] });
    const outsidePath = join(rig.rigHomeDir, "rig", "escape");

    const invalidIdentifiers = await Promise.all(
      ["../escape", "/tmp/escape", "nested/tool", "two.parts"].map((identifier) =>
        rig.run({ args: ["create", identifier] }),
      ),
    );
    for (const result of invalidIdentifiers) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("TOOL_INVALID: Invalid tool name:");
    }

    expect(await rig.exists(outsidePath)).toBe(false);

    const command = await rig.run({ args: ["run", "missing-shape"] });
    expect(command.exitCode).toBe(1);
    expect(command.stderr).toContain("INPUT_ERROR: Command id must use <tool>.<command>");
  });

  test("returns stable error envelopes for malformed and invalid command input", async () => {
    await rig.run({ args: ["init"] });
    await rig.writeTool({ name: "lifecycle", source: LifecycleToolSource });

    const malformed = await rig.run({
      args: ["run", "lifecycle.echo", "--input", "{broken"],
    });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toBe("");
    expect(malformed.json<ErrorEnvelope>()).toMatchObject({
      data: null,
      errors: [{ code: "INPUT_ERROR", message: "Input JSON is invalid." }],
    });

    const invalid = await rig.run({
      args: ["run", "lifecycle.echo", "--input", JSON.stringify({ text: 42 })],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toBe("");
    const invalidEnvelope = invalid.json<ErrorEnvelope>();
    expect(invalidEnvelope.data).toBeNull();
    expect(invalidEnvelope.errors).toHaveLength(1);
    expect(invalidEnvelope.errors[0]).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Invalid input.",
    });

    const conflicting = await rig.run({
      args: ["run", "lifecycle.echo", "positional", "--input", '{"text":"json"}'],
    });
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.json<ErrorEnvelope>().errors[0]).toMatchObject({
      code: "INPUT_ERROR",
      message: "Use args, --input, or --input-file, not more than one.",
    });
  });

  test("read and run commands preserve unrelated project and tool files byte for byte", async () => {
    await rig.run({ args: ["init"] });
    const agentsPath = await rig.writeProjectFile(
      "AGENTS.md",
      "# Human instructions\n\nKeep this exact.\n",
    );
    const toolPath = await rig.writeTool({ name: "lifecycle", source: LifecycleToolSource });
    const unrelatedPath = await rig.writeTool({
      name: "unrelated",
      source: LifecycleToolSource.replace('name: "lifecycle"', 'name: "unrelated"'),
    });
    const before = {
      agents: await rig.read(agentsPath),
      tool: await rig.read(toolPath),
      unrelated: await rig.read(unrelatedPath),
      agentsMtime: (await stat(agentsPath)).mtimeMs,
      toolMtime: (await stat(toolPath)).mtimeMs,
      unrelatedMtime: (await stat(unrelatedPath)).mtimeMs,
    };

    const commands = [
      ["list"],
      ["help", "lifecycle.echo"],
      ["inspect", "lifecycle.echo"],
      ["edit", "lifecycle"],
      ["run", "lifecycle.echo", "stable", "1"],
    ];
    const results = await Promise.all(
      commands.map((args) => rig.run({ args, env: { RIG_AGENT_SYNC: "1" } })),
    );
    for (const [index, result] of results.entries()) {
      const args = commands[index]!;
      expect(result.exitCode, `${args.join(" ")} failed: ${result.stderr}`).toBe(0);
    }

    expect(await rig.read(agentsPath)).toBe(before.agents);
    expect(await rig.read(toolPath)).toBe(before.tool);
    expect(await rig.read(unrelatedPath)).toBe(before.unrelated);
    expect((await stat(agentsPath)).mtimeMs).toBe(before.agentsMtime);
    expect((await stat(toolPath)).mtimeMs).toBe(before.toolMtime);
    expect((await stat(unrelatedPath)).mtimeMs).toBe(before.unrelatedMtime);
  });
});
