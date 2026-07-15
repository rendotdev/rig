import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ToolFindServiceClass } from "./tool-find";

class ToolFindTestHomeClass {
  private readonly paths: string[] = [];

  public async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-find-test-"));
    this.paths.push(home);
    await this.writeTool({
      home,
      name: "languagetool",
      source: `export default (rig) => rig.defineTool({
  name: "languagetool",
  description: "Check grammar, spelling, and writing style.",
  commands: {
    "check-file": rig.defineCommand({
      description: "Check grammar and spelling in a local Markdown file.",
      input: rig.z.object({ input: rig.z.string().describe("Markdown file path") }),
      output: rig.z.object({ issues: rig.z.number() }),
      examples: [{
        title: "Proofread notes",
        text: "Check a Markdown document for writing problems.",
        input: { input: "notes.md" },
        output: { issues: 0 },
      }],
      run: async () => ({ issues: 0 }),
    }),
    "check-text": rig.defineCommand({
      description: "Check a text string.",
      input: rig.z.object({
        text: rig.z.string(),
        categories: rig.z.array(rig.z.enum(["grammar", "style"]).describe("Rule category")),
        strict: rig.z.boolean().optional(),
        maxIssues: rig.z.number().optional(),
      }),
      output: rig.z.object({ issues: rig.z.number() }),
      examples: [
        { title: "Default check", text: "Check without explicit input." },
        {
          title: "Configured check",
          text: "Check selected categories.",
          input: { text: "Hello", categories: ["grammar"], strict: true, maxIssues: 2, extra: null },
          output: { issues: 0 },
        },
      ],
      run: async () => ({ issues: 0 }),
    }),
  },
});`,
    });
    await this.writeTool({
      home,
      name: "image",
      source: `export default (rig) => rig.defineTool({
  name: "image",
  description: "Resize and convert images.",
  commands: {
    convert: rig.defineCommand({
      description: "Resize an image and convert its format.",
      input: rig.z.object({ input: rig.z.string(), width: rig.z.number().optional() }),
      output: rig.z.object({ output: rig.z.string() }),
      run: async () => ({ output: "image.webp" }),
    }),
  },
});`,
    });
    return home;
  }

  public async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }

  private async writeTool(params: { home: string; name: string; source: string }): Promise<void> {
    const directory = join(params.home, "rig", "tools", params.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.rig.ts"), params.source, "utf8");
  }
}

describe("ToolFindServiceClass", () => {
  const homes = new ToolFindTestHomeClass();

  afterEach(async () => {
    await homes.cleanup();
  });

  test("finds commands through descriptions, examples, fields, and typos", async () => {
    const homeDir = await homes.create();
    const service = new ToolFindServiceClass({ homeDir });
    const result = await service.find({ query: "grammer chek markdown" });

    expect(result.results[0]).toMatchObject({
      rank: 1,
      id: "languagetool.check-file",
      tool: "languagetool",
      command: "check-file",
    });
    expect(result.results[0]?.runExample).toContain("notes.md");
    expect(result.results[0]?.matches.length).toBeGreaterThan(0);
    expect(service.renderPlain({ data: result })).toContain("1. languagetool.check-file");
  });

  test("supports tool filters, limits, input-field discovery, and no-result output", async () => {
    const homeDir = await homes.create();
    const service = new ToolFindServiceClass({ homeDir });
    const filtered = await service.find({
      query: "width resize",
      options: { tool: "image", limit: "1" },
    });

    expect(filtered).toMatchObject({ tool: "image", limit: 1 });
    expect(filtered.results).toMatchObject([{ id: "image.convert" }]);

    const empty = await service.find({ query: "quantum payroll" });
    expect(service.renderPlain({ data: empty })).toBe(
      'No Rig commands found for "quantum payroll".',
    );
    const scopedEmpty = await service.find({
      query: "quantum payroll",
      options: { tool: "image" },
    });
    expect(service.renderPlain({ data: scopedEmpty })).toBe(
      'No Rig commands found for "quantum payroll" in tool image.',
    );
    expect(
      service.renderPlain({
        data: {
          ...filtered,
          results: filtered.results.map((result) => ({
            ...result,
            runExample: "rig run image.convert input=a\r\nb\rc\td",
          })),
        },
      }),
    ).toContain("input=a\\nb\\rc\\td");
  });

  test("rejects invalid queries, limits, and tool filters", async () => {
    const homeDir = await homes.create();
    const service = new ToolFindServiceClass({ homeDir });

    await expect(service.find({ query: "   " })).rejects.toThrow("Find query cannot be empty");
    await expect(service.find({ query: "image", options: { limit: 0 } })).rejects.toThrow(
      "between 1 and 50",
    );
    await expect(service.find({ query: "image", options: { limit: "1.5" } })).rejects.toThrow(
      "between 1 and 50",
    );
    await expect(service.find({ query: "image", options: { tool: "missing" } })).rejects.toThrow(
      "Tool not found",
    );
  });
});
