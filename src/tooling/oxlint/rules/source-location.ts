import { defineRule } from "@oxlint/plugins";
import { classifySourcePath } from "../../architecture/architecture.ts";

export const sourceLocationRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require production source files to use the architecture layout." },
    messages: {
      invalidDomain:
        "Use one of Rig's configured business domains. Update the shared architecture model only when introducing a durable business capability.",
      invalidLayer:
        "Place this file in types, config, repo, service, runtime, or ui according to its responsibility.",
      invalidLocation:
        "Place production code under app, domains, providers, utils, or tooling. Keep define.ts at the source root.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const classification = classifySourcePath(context.filename);
        if (classification.kind !== "invalid") {
          return;
        }
        const messageId =
          classification.reason === "domain"
            ? "invalidDomain"
            : classification.reason === "domain-layer"
              ? "invalidLayer"
              : "invalidLocation";
        context.report({ node, messageId });
      },
    };
  },
});
