import { defineRule } from "@oxlint/plugins";
import { fileLineLimitForPath, isEnforcedSourcePath } from "../../architecture/architecture.ts";
import { countMeaningfulLines } from "./meaningful-lines.ts";

export const maxFileLinesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Limit meaningful lines in production and test files." },
    messages: {
      tooLarge:
        "This file contains {{actual}} meaningful lines and its limit is {{limit}}. Split it by domain responsibility or layer; do not move unrelated code into a generic helper.",
    },
  },
  create(context) {
    return {
      Program(node) {
        if (!isEnforcedSourcePath(context.filename)) {
          return;
        }
        const isTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(context.filename);
        const limit = fileLineLimitForPath(context.filename, isTest);
        const actual = countMeaningfulLines(context);
        if (actual > limit) {
          context.report({ node, messageId: "tooLarge", data: { actual, limit } });
        }
      },
    };
  },
});
