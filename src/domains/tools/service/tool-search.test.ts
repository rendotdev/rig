import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import { ToolSearchService, toolSearchLayer, type ToolSearchDocument } from "./tool-search";

describe("tool search", () => {
  const documents: ToolSearchDocument[] = [
    {
      id: "languagetool.check-file",
      fields: [
        { name: "command.id", value: "languagetool.check-file", weight: 12 },
        {
          name: "command.description",
          value: "Check grammar, spelling, and style in a Markdown file.",
          weight: 7,
        },
      ],
    },
    {
      id: "image.convert",
      fields: [
        { name: "command.id", value: "image.convert", weight: 12 },
        { name: "command.description", value: "Resize and convert an image.", weight: 7 },
      ],
    },
    {
      id: "documents.inspect-pdf",
      fields: [
        { name: "command.id", value: "documents.inspect-pdf", weight: 12 },
        { name: "command.description", value: "Inspect PDF metadata.", weight: 7 },
      ],
    },
  ];

  const search = (query: string, source = documents, limit = 3) =>
    Effect.runPromise(
      ToolSearchService.use((service) => service.search({ query, documents: source, limit })).pipe(
        Effect.provide(toolSearchLayer),
      ),
    );

  test("ranks typo-tolerant multi-token matches", async () => {
    const results = await search("grammer chek markdown");

    expect((await search("markdown", documents, 1))[0]?.id).toBe("languagetool.check-file");

    expect(results[0]?.id).toBe("languagetool.check-file");
    expect(results[0]?.matches.map((match) => match.field)).toContain("command.description");
  });

  test("uses names, prefixes, transpositions, and stop-word removal", async () => {
    expect((await search("inspect pdf", documents, 1))[0]?.id).toBe("documents.inspect-pdf");
    expect((await search("resize my imgae", documents, 1))[0]?.id).toBe("image.convert");
  });

  test("applies limits, stable ordering, and empty-query behavior", async () => {
    const tied: ToolSearchDocument[] = [
      { id: "b.command", fields: [{ name: "description", value: "shared", weight: 1 }] },
      { id: "a.command", fields: [{ name: "description", value: "shared", weight: 1 }] },
    ];

    expect(await search("shared", tied, 1)).toMatchObject([{ id: "a.command" }]);
    expect(await search("   ", documents, 5)).toEqual([]);
  });

  test("handles prefix directions, stop-word fallback, and irrelevant fields", async () => {
    const edgeCases: ToolSearchDocument[] = [
      {
        id: "prefixes",
        fields: [
          { name: "short", value: "inspection", weight: 2 },
          { name: "long", value: "inspect", weight: 2 },
        ],
      },
      { id: "blank", fields: [{ name: "blank", value: "", weight: 10 }] },
      { id: "weak", fields: [{ name: "weak", value: "the", weight: 0.1 }] },
      { id: "irrelevant", fields: [{ name: "value", value: "x", weight: 10 }] },
    ];

    expect((await search("inspect", edgeCases, 5))[0]?.id).toBe("prefixes");
    expect((await search("inspection report", edgeCases, 5))[0]?.id).toBe("prefixes");
    expect(await search("the", edgeCases, 5)).toEqual([]);
    expect(await search("unrelated", edgeCases, 5)).toEqual([]);
  });
});
