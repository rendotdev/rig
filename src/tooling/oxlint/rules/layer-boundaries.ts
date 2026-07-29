import { defineDependencyRule, isPublicApiViolation } from "./dependency.ts";

export const layerBoundariesRule = defineDependencyRule({
  description: "Enforce the layered domain dependency graph and top-level source boundaries.",
  message: "{{source}} cannot import {{target}}. {{remediation}} See ARCHITECTURE.md.",
  shouldReport(decision) {
    return !decision.allowed && !isPublicApiViolation(decision);
  },
});
