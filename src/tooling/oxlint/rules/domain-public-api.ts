import { defineDependencyRule, isPublicApiViolation } from "./dependency.ts";

export const domainPublicApiRule = defineDependencyRule({
  description: "Require imports to name their concrete domain module.",
  message:
    "Import the concrete service, type, or repository module directly. Barrel index.ts files are forbidden.",
  shouldReport: isPublicApiViolation,
});
