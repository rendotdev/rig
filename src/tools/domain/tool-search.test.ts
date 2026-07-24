import { describe, expect, test } from "vite-plus/test";
import {
  ToolSearchEngineClass,
  ToolSearchSingleton,
  type ToolSearchDocument,
  toolSearchEngine,
} from "./tool-search";

describe("tool search", () => {
  const engine = ToolSearchSingleton;
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

  test("ranks typo-tolerant multi-token matches", () => {
    const results = engine.search({ query: "grammer chek markdown", documents, limit: 3 });
    const adapter = new ToolSearchEngineClass();

    expect(adapter).toBeInstanceOf(ToolSearchEngineClass);
    expect(adapter.search({ query: "grammer chek markdown", documents, limit: 1 })[0]?.id).toBe(
      results[0]?.id,
    );
    expect(toolSearchEngine).toBeInstanceOf(ToolSearchEngineClass);
    expect(ToolSearchSingleton.search({ query: "markdown", documents, limit: 1 })[0]?.id).toBe(
      "languagetool.check-file",
    );

    expect(results[0]?.id).toBe("languagetool.check-file");
    expect(results[0]?.matches.map((match) => match.field)).toContain("command.description");
  });

  test("uses names, prefixes, transpositions, and stop-word removal", () => {
    expect(engine.search({ query: "inspect pdf", documents, limit: 1 })[0]?.id).toBe(
      "documents.inspect-pdf",
    );
    expect(engine.search({ query: "resize my imgae", documents, limit: 1 })[0]?.id).toBe(
      "image.convert",
    );
  });

  test("applies limits, stable ordering, and empty-query behavior", () => {
    const tied: ToolSearchDocument[] = [
      { id: "b.command", fields: [{ name: "description", value: "shared", weight: 1 }] },
      { id: "a.command", fields: [{ name: "description", value: "shared", weight: 1 }] },
    ];

    expect(engine.search({ query: "shared", documents: tied, limit: 1 })).toMatchObject([
      { id: "a.command" },
    ]);
    expect(engine.search({ query: "   ", documents, limit: 5 })).toEqual([]);
  });

  test("handles prefix directions, stop-word fallback, and irrelevant fields", () => {
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

    expect(engine.search({ query: "inspect", documents: edgeCases, limit: 5 })[0]?.id).toBe(
      "prefixes",
    );
    expect(
      engine.search({ query: "inspection report", documents: edgeCases, limit: 5 })[0]?.id,
    ).toBe("prefixes");
    expect(engine.search({ query: "the", documents: edgeCases, limit: 5 })).toEqual([]);
    expect(engine.search({ query: "unrelated", documents: edgeCases, limit: 5 })).toEqual([]);
  });
});
