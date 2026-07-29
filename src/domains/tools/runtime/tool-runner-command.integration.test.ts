import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandDefinition } from "../types/tool-types";
import * as Harness from "../../../../test/fixtures/tool-runner-test-harness";

afterEach(Harness.cleanupToolRunnerTests);

describe("tool commands", () => {
  test("normalizes non-Error JSON parser failures", async () => {
    const parse = JSON.parse;
    JSON.parse = () => {
      throw "parser failed";
    };

    try {
      await expect(
        Harness.readRunInput({} as CommandDefinition, { input: "{" }),
      ).rejects.toMatchObject({
        code: "INPUT_ERROR",
        details: { message: "parser failed" },
      });
    } finally {
      JSON.parse = parse;
    }
  });

  test("creates a starter tool with definition-owned examples", async () => {
    const home = await Harness.homes.create();
    const result = await Harness.createTool({ homeDir: home }, "sample");
    expect(result.files).toHaveLength(1);
    expect(result.toolPath).toBe(join(home, "rig", "tools", "sample", "index.rig.ts"));
    expect(result.id).toBe("sample.example");

    const help = await Harness.renderToolHelp({ homeDir: home }, "sample", "example");
    const commandIdHelp = await Harness.renderToolHelp({ homeDir: home }, "sample.example");
    expect(commandIdHelp).toMatch(
      /^Tool: sample\nCommand: example\nRun: rig run sample\.example \[args\.\.\.\]/,
    );
    expect(commandIdHelp).not.toContain("```bash");
    expect(help).toContain("Run the example command");
    expect(help).toContain("rig run sample.example");
    expect(help).toContain("Input:");
    expect(help).toContain("Output:");
  });

  test("inspects command metadata as JSON", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");
    const inspected = await Harness.inspectTool({ homeDir: home }, "sample", "example");
    expect(inspected).toMatchObject({
      tool: "sample",
      command: "example",
      id: "sample.example",
      run: "rig run sample.example [args...]",
    });
  });

  test("type-checks generated tools with injected Rig runtime types", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");
    const result = await Harness.typecheckTools({ homeDir: home }, "sample");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.checked).toHaveLength(1);
  });

  test("type-checks command output against output schemas", async () => {
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "bad-output");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `const tool: RigToolFactory = (rig) => rig.defineTool({
  name: "bad-output",
  description: "Bad output test tool.",
  commands: {
    example: rig.defineCommand({
      description: "Return the wrong output type.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async ({ input }) => ({ text: 123 }),
    }),
  },
});

export default tool;
`,
      "utf8",
    );

    const result = await Harness.typecheckTools({ homeDir: home }, "bad-output");

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
  });

  test("runs a command and returns a success envelope", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");
    const result = await Harness.createToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["Agent"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Agent" },
      errors: [],
    });
    const toolDir = join(home, "rig", "tools", "sample");
    for (const file of [
      "kv.sqlite",
      "kv.sqlite-wal",
      "kv.sqlite-shm",
      "cache.sqlite",
      "cache.sqlite-wal",
      "cache.sqlite-shm",
    ]) {
      expect(existsSync(join(toolDir, file))).toBe(false);
    }
  });

  test("resolves pipeline references in command input", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");

    const result = await Harness.createToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.output"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });

    const exactId = await Harness.createToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=@clean"],
      pipeContext: { clean: "image.cleaned.png" },
    });
    expect(exactId.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });

    const embedded = await Harness.createToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      args: ["text=output:@clean.output"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(embedded.envelope).toMatchObject({
      data: { text: "output:image.cleaned.png" },
      errors: [],
    });

    const arrayInput = await Harness.createToolRunner({ homeDir: home }).run("sample", "example", {
      homeDir: home,
      input: JSON.stringify({ text: "@names.0", ignored: ["@names.0"] }),
      pipeContext: { names: ["image.cleaned.png"] },
    });
    expect(arrayInput.envelope).toMatchObject({
      data: { text: "image.cleaned.png" },
      errors: [],
    });
  });

  test("returns pipeline reference errors as envelopes", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");
    const runner = Harness.createToolRunner({ homeDir: home });

    const unknown = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@missing.output"],
      pipeContext: {},
    });
    expect(unknown.envelope).toMatchObject({
      errors: [{ code: "INPUT_ERROR", message: "Pipeline reference is unknown: @missing" }],
    });

    const cannotAccess = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.output.path"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(cannotAccess.envelope).toMatchObject({
      errors: [
        {
          code: "INPUT_ERROR",
          message: "Pipeline reference cannot access: @clean.output.path",
        },
      ],
    });

    const missing = await runner.run("sample", "example", {
      homeDir: home,
      args: ["text=@clean.missing"],
      pipeContext: { clean: { output: "image.cleaned.png" } },
    });
    expect(missing.envelope).toMatchObject({
      errors: [{ code: "INPUT_ERROR", message: "Pipeline reference is missing: @clean.missing" }],
    });
  });

  test("runs registered tools from a tool context", async () => {
    const home = await Harness.homes.create();
    await Harness.createTool({ homeDir: home }, "sample");
    const toolDir = join(home, "rig", "tools", "caller");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "caller",
  description: "Tool runner test tool.",
  commands: {
    call: rig.defineCommand({
      description: "Call another Rig tool.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => {
        const result = await context.rig.run({
          command: "sample.example",
          input: { text: context.input.text },
        });
        return { text: result.text };
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await Harness.createToolRunner({ homeDir: home }).run("caller", "call", {
      homeDir: home,
      input: '{"text":"Nested"}',
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      data: { text: "Nested" },
      errors: [],
    });
  });

  test("reuses loaded definitions across nested calls in one execution session", async () => {
    const home = await Harness.homes.create();
    const toolsDir = join(home, "rig", "tools");
    const calleeDir = join(toolsDir, "callee");
    const callerDir = join(toolsDir, "caller");
    await mkdir(calleeDir, { recursive: true });
    await mkdir(callerDir, { recursive: true });
    await writeFile(
      join(calleeDir, "index.rig.ts"),
      `export default (rig) => {
  globalThis.__rigNestedDefinitionLoads = (globalThis.__rigNestedDefinitionLoads ?? 0) + 1;
  const definitionLoad = globalThis.__rigNestedDefinitionLoads;
  return rig.defineTool({
    name: "callee",
    description: "Nested cache test callee.",
    commands: {
      read: rig.defineCommand({
        description: "Return the definition load count.",
        input: rig.z.object({}),
        output: rig.z.number(),
        run: () => definitionLoad,
      }),
    },
  });
};
`,
      "utf8",
    );
    await writeFile(
      join(callerDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "caller",
  description: "Nested cache test caller.",
  commands: {
    call: rig.defineCommand({
      description: "Call another Rig tool repeatedly.",
      input: rig.z.object({ count: rig.z.number() }),
      output: rig.z.array(rig.z.number()),
      run: async (context) => {
        const values = [];
        for (let index = 0; index < context.input.count; index++) {
          values.push(await context.rig.run({ command: "callee.read" }));
        }
        return values;
      },
    }),
  },
});
`,
      "utf8",
    );

    const result = await Harness.createToolRunner({ homeDir: home }).run("caller", "call", {
      input: JSON.stringify({ count: 50 }),
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect((result.envelope as { data: number[] }).data).toEqual(Array(50).fill(1));
  });

  test("runs tools that import modules resolved from node_modules", async () => {
    const home = await Harness.homes.create();
    const packageDir = join(home, "node_modules", "tool-helper");
    const toolDir = join(home, "rig", "tools", "external-import");
    await mkdir(packageDir, { recursive: true });
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      '{"name":"tool-helper","type":"module","exports":"./index.js"}\n',
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.js"),
      "export function shout(value) { return String(value).toUpperCase(); }\n",
      "utf8",
    );
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `import { shout } from "tool-helper";

export default (rig) => rig.defineTool({
  name: "external-import",
  description: "External import test tool.",
  commands: {
    shout: rig.defineCommand({
      description: "Use an imported helper.",
      input: rig.z.object({ text: rig.z.string() }),
      output: rig.z.object({ text: rig.z.string() }),
      run: async (context) => ({ text: shout(context.input.text) }),
    }),
  },
});
`,
      "utf8",
    );

    const originalCwd = process.cwd();
    try {
      const result = await Harness.createToolRunner({ homeDir: home }).run(
        "external-import",
        "shout",
        {
          homeDir: home,
          input: '{"text":"modules"}',
        },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        envelope: { data: { text: "MODULES" }, errors: [] },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("validates tool .env and passes it to command contexts", async () => {
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "with-env");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, ".env"),
      [
        "# Local tool env",
        "API_TOKEN=secret",
        "LIMIT=3",
        'MESSAGE="hello world"',
        "SINGLE='literal value'",
        "export OWNER=agent",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "with-env",
  description: "Env test tool.",
  env: rig.z.object({
    API_TOKEN: rig.z.string().min(1),
    LIMIT: rig.z.coerce.number(),
    MESSAGE: rig.z.string(),
    SINGLE: rig.z.string(),
    OWNER: rig.z.string(),
  }),
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({
        token: rig.z.string(),
        limit: rig.z.number(),
        message: rig.z.string(),
        single: rig.z.string(),
        owner: rig.z.string(),
      }),
      run: async (context) => ({
        token: context.env.API_TOKEN,
        limit: context.env.LIMIT,
        message: context.env.MESSAGE,
        single: context.env.SINGLE,
        owner: context.env.OWNER,
      }),
    }),
  },
});
`,
      "utf8",
    );

    const result = await Harness.createToolRunner({ homeDir: home }).run("with-env", "read", {
      homeDir: home,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      envelope: {
        data: {
          token: "secret",
          limit: 3,
          message: "hello world",
          single: "literal value",
          owner: "agent",
        },
        errors: [],
      },
    });

    const dryRun = await Harness.createToolRunner({ homeDir: home }).run("with-env", "read", {
      homeDir: home,
      dryRun: true,
    });
    expect(JSON.stringify(dryRun.envelope)).not.toContain("secret");
  });

  test("renders metadata without loading required tool environment values", async () => {
    const home = await Harness.homes.create();
    const toolDir = join(home, "rig", "tools", "metadata-env");
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  name: "metadata-env",
  description: "Metadata without env values.",
  env: rig.z.object({ API_TOKEN: rig.z.string() }),
  commands: {
    read: rig.defineCommand({
      description: "Read required env.",
      input: rig.z.object({}),
      output: rig.z.string(),
      run: (context) => context.env.API_TOKEN,
    }),
  },
});\n`,
      "utf8",
    );

    expect((await Harness.makeToolListClient({ homeDir: home }).list()).tools[0]?.name).toBe(
      "metadata-env",
    );
    expect(await Harness.renderToolHelp({ homeDir: home }, "metadata-env")).toContain(
      "# metadata-env",
    );
    expect(await Harness.inspectTool({ homeDir: home }, "metadata-env")).toMatchObject({
      name: "metadata-env",
    });
  });

  test("returns tool env load errors as envelopes", async () => {
    const cases = [
      {
        name: "missing-env",
        envFile: undefined,
        envSchema: "env: rig.z.object({ API_TOKEN: rig.z.string().min(1) }),",
        message: "env is invalid",
      },
      {
        name: "env-without-schema",
        envFile: "API_TOKEN=secret\n",
        envSchema: "",
        message: "has .env but no env schema",
      },
      {
        name: "bad-env-line",
        envFile: "not a valid env line\n",
        envSchema: "env: rig.z.object({}),",
        message: "Invalid .env line",
      },
    ];

    const results = await Promise.all(
      cases.map(async (item) => {
        const home = await Harness.homes.create();
        const toolDir = join(home, "rig", "tools", item.name);
        await mkdir(toolDir, { recursive: true });
        if (item.envFile !== undefined)
          await writeFile(join(toolDir, ".env"), item.envFile, "utf8");
        await writeFile(
          join(toolDir, "index.rig.ts"),
          `export default (rig) => rig.defineTool({
  name: ${JSON.stringify(item.name)},
  description: "Env error test tool.",
  ${item.envSchema}
  commands: {
    read: rig.defineCommand({
      description: "Read env.",
      input: rig.z.object({}),
      output: rig.z.object({ ok: rig.z.boolean() }),
      run: async () => ({ ok: true }),
    }),
  },
});
`,
          "utf8",
        );

        return {
          item,
          result: await Harness.createToolRunner({ homeDir: home }).run(item.name, "read", {
            homeDir: home,
          }),
        };
      }),
    );

    for (const { item, result } of results) {
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          errors: [{ code: "TOOL_INVALID", message: expect.stringContaining(item.message) }],
        },
      });
    }
  });
});
