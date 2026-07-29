import { dirname, posix, resolve, sep } from "node:path";

export const domainNames = [
  "collections",
  "registry",
  "scheduling",
  "settings",
  "tools",
  "updates",
] as const;
export const domainLayers = ["types", "config", "repo", "service", "runtime", "ui"] as const;
const productionFileLineLimit = 400;
const testFileLineLimit = 600;
const functionLineLimit = 80;

export function fileLineLimitForPath(filePath: string, isTest: boolean) {
  return isTest ? testFileLineLimit : productionFileLineLimit;
}

export function functionLineLimitForPath(_filePath: string) {
  return functionLineLimit;
}

export type DomainName = (typeof domainNames)[number];
export type DomainLayer = (typeof domainLayers)[number];

export const allowedDomainDependencies: Readonly<Record<DomainName, readonly DomainName[]>> = {
  collections: [],
  registry: ["settings"],
  scheduling: ["settings", "tools"],
  settings: [],
  tools: ["collections", "registry", "settings"],
  updates: ["settings"],
};

export const allowedLayerDependencies: Readonly<Record<DomainLayer, readonly DomainLayer[]>> = {
  types: ["types"],
  config: ["types", "config"],
  repo: ["types", "config", "repo"],
  service: ["types", "config", "repo", "service"],
  runtime: ["types", "config", "service", "runtime"],
  ui: ["types", "config", "service", "runtime", "ui"],
};

type SourceClassification =
  | Readonly<{
      kind: "app" | "providers" | "utils" | "tooling" | "outside-source";
    }>
  | Readonly<{ kind: "domain-layer"; domain: DomainName; layer: DomainLayer }>
  | Readonly<{ kind: "invalid"; reason: "domain" | "domain-layer" | "source-location" }>;

export type DependencyDecision = Readonly<{
  allowed: boolean;
  reason?: "cross-domain" | "layer" | "top-level";
  source: SourceClassification;
  target: SourceClassification;
}>;

export function classifySourcePath(filePath: string): SourceClassification {
  const sourcePath = getSourceRelativePath(filePath);
  if (!sourcePath) {
    return { kind: "outside-source" };
  }
  if (/(?:^|\/)index\.tsx?$/u.test(sourcePath)) {
    return { kind: "invalid", reason: "source-location" };
  }
  const [topLevel, second, third] = sourcePath.split("/");
  const isProductionTopLevel =
    topLevel === "app" || topLevel === "providers" || topLevel === "utils";
  if (isProductionTopLevel) {
    return { kind: topLevel };
  }
  if (topLevel === "tooling") {
    return { kind: "tooling" };
  }
  if (topLevel !== "domains") {
    return { kind: "invalid", reason: "source-location" };
  }
  if (!isDomainName(second)) {
    return { kind: "invalid", reason: "domain" };
  }
  if (!isDomainLayer(third)) {
    return { kind: "invalid", reason: "domain-layer" };
  }
  return { kind: "domain-layer", domain: second, layer: third };
}

export function resolveImportTarget(sourceFile: string, specifier: string) {
  const normalizedSpecifier = specifier.split(/[?#]/u)[0];
  if (!normalizedSpecifier?.startsWith(".")) {
    return undefined;
  }
  return normalizePath(resolve(dirname(sourceFile), normalizedSpecifier));
}

export function validateDependency(sourceFile: string, targetFile: string): DependencyDecision {
  const source = classifySourcePath(sourceFile);
  const target = classifySourcePath(targetFile);
  const usesOutsideSource = source.kind === "outside-source" || target.kind === "outside-source";
  if (usesOutsideSource) {
    return { allowed: true, source, target };
  }
  const hasInvalidLocation = source.kind === "invalid" || target.kind === "invalid";
  if (hasInvalidLocation) {
    return { allowed: true, source, target };
  }
  if (source.kind === "app") {
    const isAppDomainTarget =
      target.kind === "domain-layer" &&
      ["types", "service", "runtime", "ui"].includes(target.layer);
    const allowed =
      target.kind === "app" ||
      target.kind === "providers" ||
      target.kind === "utils" ||
      isAppDomainTarget;
    return {
      allowed,
      reason: "top-level",
      source,
      target,
    };
  }
  if (source.kind === "providers") {
    const allowed = target.kind === "providers" || target.kind === "utils";
    return { allowed, reason: "top-level", source, target };
  }
  if (source.kind === "utils") {
    return { allowed: target.kind === "utils", reason: "top-level", source, target };
  }
  if (source.kind === "tooling") {
    const allowed = target.kind === "tooling" || target.kind === "utils";
    return { allowed, reason: "top-level", source, target };
  }
  if (source.kind !== "domain-layer") {
    return { allowed: false, reason: "top-level", source, target };
  }
  return validateDomainLayerDependency(source, target);
}

export function isEnforcedSourcePath(filePath: string) {
  const classification = classifySourcePath(filePath);
  return classification.kind !== "outside-source";
}

export function validateArchitectureModel() {
  const errors: string[] = [];
  for (const layer of domainLayers) {
    const dependencies = allowedLayerDependencies[layer];
    if (!dependencies.includes(layer)) {
      errors.push(`${layer} must be allowed to import itself.`);
    }
    for (const dependency of dependencies) {
      if (!domainLayers.includes(dependency)) {
        errors.push(`${layer} references the unknown layer ${dependency}.`);
      }
    }
  }
  const cycle = findLayerDependencyCycle(allowedLayerDependencies);
  if (cycle) {
    errors.push(`Layer dependency cycle: ${cycle.join(" -> ")}.`);
  }
  for (const domain of domainNames) {
    for (const dependency of allowedDomainDependencies[domain]) {
      if (!domainNames.includes(dependency)) {
        errors.push(`${domain} references the unknown domain ${dependency}.`);
      }
      if (dependency === domain) {
        errors.push(`${domain} must not declare itself as a domain dependency.`);
      }
    }
  }
  const domainCycle = findDomainDependencyCycle(allowedDomainDependencies);
  if (domainCycle) {
    errors.push(`Domain dependency cycle: ${domainCycle.join(" -> ")}.`);
  }
  return errors;
}

function validateDomainLayerDependency(
  source: Extract<SourceClassification, { kind: "domain-layer" }>,
  target: Exclude<SourceClassification, { kind: "invalid" }>,
): DependencyDecision {
  const isCrossCuttingTarget = target.kind === "providers" || target.kind === "utils";
  if (isCrossCuttingTarget) {
    const allowsProviders = ["repo", "service", "runtime"].includes(source.layer);
    return {
      allowed: target.kind === "utils" || allowsProviders,
      reason: "layer",
      source,
      target,
    };
  }
  if (target.kind !== "domain-layer") {
    return { allowed: false, reason: "top-level", source, target };
  }
  if (target.domain !== source.domain) {
    const allowsDomain = allowedDomainDependencies[source.domain].includes(target.domain);
    const allowsTargetLayer =
      target.layer === "types" ||
      (target.layer === "service" && ["service", "runtime", "ui"].includes(source.layer)) ||
      (target.layer === "runtime" && ["runtime", "ui"].includes(source.layer));
    return {
      allowed: allowsDomain && allowsTargetLayer,
      reason: "cross-domain",
      source,
      target,
    };
  }
  const allowed = allowedLayerDependencies[source.layer].includes(target.layer);
  return { allowed, reason: "layer", source, target };
}

export function describeSourceClassification(classification: SourceClassification) {
  if (classification.kind === "domain-layer") {
    return `${classification.domain}/${classification.layer}`;
  }
  if (classification.kind === "invalid") {
    return `invalid ${classification.reason}`;
  }
  return classification.kind;
}

export function dependencyRemediation(decision: DependencyDecision) {
  const isDomainLayerDependency =
    decision.source.kind === "domain-layer" && decision.target.kind === "domain-layer";
  if (isDomainLayerDependency) {
    if (decision.source.domain !== decision.target.domain) {
      const declared = allowedDomainDependencies[decision.source.domain];
      const domainList = declared.length > 0 ? declared.join(", ") : "no other domains";
      return `Route the dependency through an allowed types, service, or runtime contract at the same or an earlier layer. ${decision.source.domain} may depend on ${domainList}.`;
    }
    const layers = allowedLayerDependencies[decision.source.layer].join(", ");
    return `Move the dependency behind ${decision.source.layer} or an earlier allowed layer. ${decision.source.layer} may import ${layers}.`;
  }
  const isDomainProviderDependency =
    decision.source.kind === "domain-layer" && decision.target.kind === "providers";
  if (isDomainProviderDependency) {
    return "Inject Providers through repo, service, or runtime. UI, config, and types must use domain contracts.";
  }
  const isAppDomainDependency =
    decision.source.kind === "app" && decision.target.kind === "domain-layer";
  if (isAppDomainDependency) {
    return "App code consumes domain types, service contracts, runtimes, and UI. Close config and repo dependencies inside exported domain Layers.";
  }
  return "Move the dependency to the owning domain layer or compose it in app wiring.";
}

export function findLayerDependencyCycle(
  graph: Readonly<Record<DomainLayer, readonly DomainLayer[]>>,
) {
  const visited = new Set<DomainLayer>();
  const active = new Set<DomainLayer>();
  const path: DomainLayer[] = [];
  function visit(layer: DomainLayer): DomainLayer[] | undefined {
    visited.add(layer);
    active.add(layer);
    path.push(layer);
    for (const dependency of graph[layer]) {
      if (dependency === layer) {
        continue;
      }
      if (active.has(dependency)) {
        return [...path.slice(path.indexOf(dependency)), dependency];
      }
      if (!visited.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
      }
    }
    path.pop();
    active.delete(layer);
    return undefined;
  }
  for (const layer of domainLayers) {
    if (!visited.has(layer)) {
      const cycle = visit(layer);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

export function findDomainDependencyCycle(
  graph: Readonly<Partial<Record<DomainName, readonly DomainName[]>>>,
) {
  const visited = new Set<DomainName>();
  const active = new Set<DomainName>();
  const path: DomainName[] = [];
  function visit(domain: DomainName): DomainName[] | undefined {
    visited.add(domain);
    active.add(domain);
    path.push(domain);
    for (const dependency of graph[domain] ?? []) {
      if (active.has(dependency)) {
        return [...path.slice(path.indexOf(dependency)), dependency];
      }
      if (!visited.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
      }
    }
    path.pop();
    active.delete(domain);
    return undefined;
  }
  for (const domain of domainNames) {
    if (!visited.has(domain)) {
      const cycle = visit(domain);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

function getSourceRelativePath(filePath: string) {
  const normalized = normalizePath(filePath);
  const marker = "/src/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length);
  }
  return normalized.startsWith("src/") ? normalized.slice("src/".length) : undefined;
}

function isDomainName(value: string | undefined): value is DomainName {
  return domainNames.some((domain) => domain === value);
}

function isDomainLayer(value: string | undefined): value is DomainLayer {
  return domainLayers.some((layer) => layer === value);
}

function normalizePath(filePath: string) {
  return posix.normalize(filePath.split(sep).join("/"));
}
