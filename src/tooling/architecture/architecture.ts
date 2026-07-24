import { dirname, posix, resolve, sep } from "node:path";

export const domainNames = [
  "collections",
  "registry",
  "scheduling",
  "settings",
  "tools",
  "updates",
] as const;
export const migratedDomainNames = ["settings"] as const;
export const domainLayers = ["types", "config", "repo", "service", "runtime", "ui"] as const;
export const productionFileLineLimit = 400;
export const testFileLineLimit = 600;
export const functionLineLimit = 80;

const migrationFileLineLimits: Readonly<Record<string, number>> = {
  "src/application/cli/cli-application.ts": 664,
  "src/collections/application/tool-collection.ts": 962,
  "src/cron/application/rig-cron.ts": 732,
  "src/generated/agent/agent-instruction-sync.ts": 468,
  "src/generated/runtime/runtime-support.ts": 539,
  "src/persistence/cache/tool-cache.ts": 413,
  "src/runtime/support.test.ts": 1_192,
  "src/runtime/updates/rig-updater.ts": 449,
  "src/tools/collection.test.ts": 911,
  "src/tools/cron.test.ts": 662,
  "src/tools/loading/tool-loader.ts": 509,
  "src/tools/presentation/tool-list.ts": 465,
  "src/tools/run.test.ts": 1_424,
};

const migrationFunctionLineLimits: Readonly<Record<string, number>> = {
  "src/application/cli/cli-application.ts": 420,
  "src/collections/persistence/memory-index.ts": 123,
  "src/collections/application/tool-collection.ts": 320,
  "src/config/application/config-store.ts": 121,
  "src/domains/settings/repo/file-lock.ts": 119,
  "src/domains/settings/repo/rig-paths.ts": 109,
  "src/domains/settings/service/directory-migration.ts": 130,
  "src/cron/application/rig-cron.ts": 360,
  "src/dev/dev-link.ts": 133,
  "src/generated/agent/agent-instruction-sync.ts": 240,
  "src/generated/runtime/runtime-support.ts": 280,
  "src/persistence/cache/tool-cache.ts": 220,
  "src/registry/application/discover-tools.ts": 170,
  "src/registry/registry.test.ts": 133,
  "src/runtime/logging/logger.ts": 91,
  "src/runtime/process/shell.ts": 81,
  "src/runtime/support.test.ts": 320,
  "src/runtime/updates/npm-update-check.ts": 81,
  "src/runtime/updates/rig-updater.ts": 260,
  "src/tools/collection.test.ts": 300,
  "src/tools/cron.test.ts": 260,
  "src/tools/domain/tool-search.ts": 109,
  "src/tools/env.test.ts": 102,
  "src/tools/execution/tool-runner.ts": 90,
  "src/tools/loading/tool-loader.ts": 240,
  "src/tools/management/tool-env.ts": 102,
  "src/tools/management/tool-typecheck.ts": 124,
  "src/tools/presentation/tool-list.ts": 240,
  "src/tools/run.test.ts": 320,
};

export const legacySourceRoots = [
  "agents",
  "application",
  "collections",
  "config",
  "cron",
  "dev",
  "errors",
  "generated",
  "persistence",
  "registry",
  "runtime",
  "tools",
] as const;

export function fileLineLimitForPath(filePath: string, isTest: boolean) {
  return (
    migrationFileLineLimits[sourcePathKey(filePath)] ??
    (isTest ? testFileLineLimit : productionFileLineLimit)
  );
}

export function functionLineLimitForPath(filePath: string) {
  return migrationFunctionLineLimits[sourcePathKey(filePath)] ?? functionLineLimit;
}

export type DomainName = (typeof domainNames)[number];
export type DomainLayer = (typeof domainLayers)[number];

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
      kind: "app" | "providers" | "utils" | "tooling" | "definition" | "legacy" | "outside-source";
    }>
  | Readonly<{ kind: "domain-public"; domain: DomainName }>
  | Readonly<{ kind: "domain-layer"; domain: DomainName; layer: DomainLayer }>
  | Readonly<{ kind: "invalid"; reason: "domain" | "domain-layer" | "source-location" }>;

export type DependencyDecision = Readonly<{
  allowed: boolean;
  reason?: "app-internal-domain" | "cross-domain-internal" | "layer" | "top-level";
  source: SourceClassification;
  target: SourceClassification;
}>;

export function classifySourcePath(filePath: string): SourceClassification {
  const sourcePath = getSourceRelativePath(filePath);
  if (!sourcePath) {
    return { kind: "outside-source" };
  }
  const isDefinition = sourcePath === "define.ts" || sourcePath === "define.test.ts";
  if (isDefinition) {
    return { kind: "definition" };
  }
  const [topLevel, second, third, fourth] = sourcePath.split("/");
  const isLegacyRootFile = !sourcePath.includes("/");
  const usesLegacyLocation = isLegacyRootFile || isLegacySourceRoot(topLevel);
  if (usesLegacyLocation) {
    return { kind: "legacy" };
  }
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
  const isDomainPublicApi = third === "index.ts" || third === "index.tsx";
  if (isDomainPublicApi) {
    return { kind: "domain-public", domain: second };
  }
  const isLayerPublicApi =
    isDomainLayer(third) && (fourth === "index.ts" || fourth === "index.tsx");
  if (isLayerPublicApi) {
    return { kind: "domain-public", domain: second };
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
  if (source.kind === "legacy") {
    return { allowed: true, source, target };
  }
  if (target.kind === "legacy") {
    return { allowed: false, reason: "top-level", source, target };
  }
  if (target.kind === "definition") {
    return {
      allowed: source.kind !== "utils" && source.kind !== "tooling",
      reason: "top-level",
      source,
      target,
    };
  }
  if (source.kind === "definition") {
    return { allowed: target.kind === "providers", reason: "top-level", source, target };
  }
  if (source.kind === "app") {
    const allowed =
      target.kind === "app" ||
      target.kind === "providers" ||
      target.kind === "utils" ||
      target.kind === "domain-public";
    return {
      allowed,
      reason: target.kind === "domain-layer" ? "app-internal-domain" : "top-level",
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
  if (source.kind === "domain-public") {
    const isSameDomainLayer = target.kind === "domain-layer" && target.domain === source.domain;
    const isSameDomainPublicApi =
      target.kind === "domain-public" && target.domain === source.domain;
    const allowed = isSameDomainLayer || isSameDomainPublicApi;
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
  return errors;
}

function validateDomainLayerDependency(
  source: Extract<SourceClassification, { kind: "domain-layer" }>,
  target: Exclude<SourceClassification, { kind: "invalid" | "definition" }>,
): DependencyDecision {
  if (target.kind === "domain-public") {
    const allowed = target.domain !== source.domain;
    return { allowed, reason: "cross-domain-internal", source, target };
  }
  const isCrossCuttingTarget = target.kind === "providers" || target.kind === "utils";
  if (isCrossCuttingTarget) {
    const allowsProviders = ["repo", "service", "runtime", "ui"].includes(source.layer);
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
    return { allowed: false, reason: "cross-domain-internal", source, target };
  }
  const allowed = allowedLayerDependencies[source.layer].includes(target.layer);
  return { allowed, reason: "layer", source, target };
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

function sourcePathKey(filePath: string) {
  const relativePath = getSourceRelativePath(filePath);
  return relativePath ? `src/${relativePath}` : normalizePath(filePath);
}

function isDomainName(value: string | undefined): value is DomainName {
  return domainNames.some((domain) => domain === value);
}

function isLegacySourceRoot(value: string | undefined) {
  return legacySourceRoots.some((root) => root === value);
}

function isDomainLayer(value: string | undefined): value is DomainLayer {
  return domainLayers.some((layer) => layer === value);
}

function normalizePath(filePath: string) {
  return posix.normalize(filePath.split(sep).join("/"));
}
