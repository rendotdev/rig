import type { Node, Ranged } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";
import { functionLineLimitForPath, isEnforcedSourcePath } from "../../architecture/architecture.ts";
import { countMeaningfulLines } from "./meaningful-lines.ts";

export const maxFunctionLinesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Limit meaningful lines in functions and methods." },
    messages: {
      tooLarge:
        "This function or method contains {{actual}} meaningful lines and its limit is {{limit}}. Extract cohesive behavior or move orchestration into the appropriate runtime.",
    },
  },
  create(context) {
    if (!isEnforcedSourcePath(context.filename)) {
      return {};
    }
    function inspect(node: Node & Ranged) {
      if (isTestSuiteCallback(node)) {
        return;
      }
      const actual = countMeaningfulLines(context, node.range);
      const limit = functionLineLimitForPath(context.filename);
      if (actual > limit) {
        context.report({ node, messageId: "tooLarge", data: { actual, limit } });
      }
    }
    return {
      FunctionDeclaration: inspect,
      FunctionExpression: inspect,
      ArrowFunctionExpression: inspect,
    };
  },
});

function isTestSuiteCallback(node: Node) {
  const parent = (
    node as unknown as {
      readonly parent?: {
        readonly type: string;
        readonly callee?: { readonly type: string; readonly name?: string };
      };
    }
  ).parent;
  if (parent?.type !== "CallExpression") {
    return false;
  }
  const callee = parent.callee;
  if (!callee) {
    return false;
  }
  const isNamedCall = callee.type === "Identifier";
  return isNamedCall && (callee.name === "describe" || callee.name === "suite");
}
