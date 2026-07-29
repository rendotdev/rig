import { definePlugin } from "@oxlint/plugins";
import { domainPublicApiRule } from "./rules/domain-public-api.ts";
import { effectRuntimeBoundaryRule } from "./rules/effect-runtime-boundary.ts";
import { effectServiceContractRule } from "./rules/effect-service-contract.ts";
import { layerBoundariesRule } from "./rules/layer-boundaries.ts";
import { maxFileLinesRule } from "./rules/max-file-lines.ts";
import { maxFunctionLinesRule } from "./rules/max-function-lines.ts";
import { namedCompoundIfConditionRule } from "./rules/named-compound-if-condition.ts";
import { noBarrelFilesRule } from "./rules/no-barrel-files.ts";
import { noFloatingBehaviorRule } from "./rules/no-floating-behavior.ts";
import { sourceLocationRule } from "./rules/source-location.ts";

export {
  domainPublicApiRule,
  effectRuntimeBoundaryRule,
  effectServiceContractRule,
  layerBoundariesRule,
  maxFileLinesRule,
  maxFunctionLinesRule,
  namedCompoundIfConditionRule,
  noBarrelFilesRule,
  noFloatingBehaviorRule,
  sourceLocationRule,
};

export default definePlugin({
  meta: { name: "rig" },
  rules: {
    "domain-public-api": domainPublicApiRule,
    "effect-runtime-boundary": effectRuntimeBoundaryRule,
    "effect-service-contract": effectServiceContractRule,
    "layer-boundaries": layerBoundariesRule,
    "max-file-lines": maxFileLinesRule,
    "max-function-lines": maxFunctionLinesRule,
    "named-compound-if-condition": namedCompoundIfConditionRule,
    "no-barrel-files": noBarrelFilesRule,
    "no-floating-behavior": noFloatingBehaviorRule,
    "source-location": sourceLocationRule,
  },
});
