import type { Context, Rule } from "@oxlint/plugins";

export const createOxlintContext = (
  filename: string,
  text: string,
  report: (message: unknown) => void,
  comments: Array<{ type: string; value: string; range: [number, number] }> = [],
) =>
  ({
    filename,
    report,
    sourceCode: {
      text,
      getAllComments: () => comments,
    },
  }) as unknown as Context;

export const createOxlintVisitor = (rule: Rule, context: Context) => {
  const create = rule.create;
  if (!create) {
    throw new Error("The Oxlint rule must provide a create visitor.");
  }
  return create(context);
};

export const oxlintImportNode = (value: string) => ({
  type: "ImportDeclaration",
  source: { type: "Literal", value },
});

export const meaningfulSource = (lines: number) =>
  Array.from({ length: lines }, (_, index) => `const value${index} = ${index};`).join("\n");
