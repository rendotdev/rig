import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  allowedLayerDependencies,
  classifySourcePath,
  type DomainName,
  domainLayers,
  domainNames,
  fileLineLimitForPath,
  findDomainDependencyCycle,
  findLayerDependencyCycle,
  functionLineLimitForPath,
  migratedDomainNames,
  resolveImportTarget,
  validateArchitectureModel,
  validateDependency,
} from "./architecture.ts";

const root = "/repo/src";
const sourceRoot = resolve(import.meta.dirname, "../..");

describe("architecture model", () => {
  it("defines an acyclic dependency graph", () => {
    expect(validateArchitectureModel()).toEqual([]);
  });

  it("ratchets known size debt without weakening the default limits", () => {
    expect(
      fileLineLimitForPath("/repo/src/collections/application/tool-collection.ts", false),
    ).toBe(962);
    expect(functionLineLimitForPath("/repo/src/cron/application/rig-cron.ts")).toBe(360);
    expect(fileLineLimitForPath("/repo/src/domains/tools/service/new.ts", false)).toBe(400);
    expect(functionLineLimitForPath("/repo/src/domains/tools/service/new.ts")).toBe(80);
  });

  it("detects a dependency cycle", () => {
    const cyclicGraph = { ...allowedLayerDependencies, types: ["types", "ui"] } as const;

    expect(findLayerDependencyCycle(cyclicGraph)).toEqual(["types", "ui", "types"]);
  });

  it("defines unique durable business domains", () => {
    expect(new Set(domainNames).size).toBe(domainNames.length);
  });

  it("requires migrated domains to expose a public API", async () => {
    await Promise.all(
      migratedDomainNames.map(async (domain) => {
        await expect(
          access(join(sourceRoot, "domains", domain, "index.ts")),
        ).resolves.toBeUndefined();
      }),
    );
  });

  it("keeps the repository cross-domain graph acyclic", async () => {
    const graph = await collectDomainDependencyGraph();

    expect(findDomainDependencyCycle(graph)).toBeUndefined();
  });

  it("defines every source and target layer edge", () => {
    for (const source of domainLayers) {
      for (const target of domainLayers) {
        const decision = validateDependency(
          `${root}/domains/tools/${source}/source.ts`,
          `${root}/domains/tools/${target}/target.ts`,
        );
        expect(decision.allowed).toBe(allowedLayerDependencies[source].includes(target));
      }
    }
  });

  it("allows providers only in behavior-bearing domain layers", () => {
    for (const layer of domainLayers) {
      const decision = validateDependency(
        `${root}/domains/tools/${layer}/source.ts`,
        `${root}/providers/filesystem/filesystem.ts`,
      );
      expect(decision.allowed).toBe(["repo", "service", "runtime", "ui"].includes(layer));
    }
  });
});

describe("dependency boundaries", () => {
  it("requires app and cross-domain imports to use public APIs", () => {
    expect(
      validateDependency(`${root}/app/cli/cli.ts`, `${root}/domains/tools/service/run-tool.ts`)
        .allowed,
    ).toBe(false);
    expect(
      validateDependency(`${root}/app/cli/cli.ts`, `${root}/domains/tools/index.ts`).allowed,
    ).toBe(true);
    expect(
      validateDependency(`${root}/app/cli/main.tsx`, `${root}/domains/tools/ui/index.ts`).allowed,
    ).toBe(true);
    expect(
      validateDependency(
        `${root}/domains/tools/service/run-tool.ts`,
        `${root}/domains/settings/repo/store.ts`,
      ).allowed,
    ).toBe(false);
    expect(
      validateDependency(
        `${root}/domains/tools/service/run-tool.ts`,
        `${root}/domains/settings/index.ts`,
      ).allowed,
    ).toBe(true);
  });

  it("isolates providers, utilities, tooling, and app wiring", () => {
    expect(
      validateDependency(
        `${root}/providers/filesystem/filesystem.ts`,
        `${root}/domains/tools/index.ts`,
      ).allowed,
    ).toBe(false);
    expect(
      validateDependency(`${root}/utils/arrays.ts`, `${root}/providers/time/time.ts`).allowed,
    ).toBe(false);
    expect(
      validateDependency(`${root}/domains/tools/ui/tool.tsx`, `${root}/app/cli/main.tsx`).allowed,
    ).toBe(false);
    expect(
      validateDependency(
        `${root}/domains/tools/service/run-tool.ts`,
        `${root}/tooling/architecture/architecture.ts`,
      ).allowed,
    ).toBe(false);
  });
});

describe("source classification", () => {
  it("classifies invalid domains and layers", () => {
    expect(classifySourcePath(`${root}/domains/payments/types/payment.ts`)).toEqual({
      kind: "invalid",
      reason: "domain",
    });
    expect(classifySourcePath(`${root}/domains/tools/helpers/helper.ts`)).toEqual({
      kind: "invalid",
      reason: "domain-layer",
    });
  });

  it("recognizes domain and layer public entrypoints", () => {
    expect(classifySourcePath(`${root}/domains/tools/index.ts`)).toEqual({
      kind: "domain-public",
      domain: "tools",
    });
    expect(classifySourcePath(`${root}/domains/tools/ui/index.ts`)).toEqual({
      kind: "domain-public",
      domain: "tools",
    });
  });

  it("recognizes current legacy roots while rejecting new ad hoc locations", () => {
    for (const path of ["tools/run.ts", "runtime/process/shell.ts", "cli.ts"]) {
      expect(classifySourcePath(`${root}/${path}`)).toEqual({ kind: "legacy" });
    }
    expect(classifySourcePath(`${root}/helpers/helper.ts`)).toEqual({
      kind: "invalid",
      reason: "source-location",
    });
  });

  it("resolves local imports without treating packages as source dependencies", () => {
    expect(resolveImportTarget(`${root}/app/cli/cli.ts`, "../../domains/tools/index.ts")).toBe(
      `${root}/domains/tools/index.ts`,
    );
    expect(resolveImportTarget(`${root}/app/cli/cli.ts`, "react")).toBeUndefined();
  });
});

async function collectDomainDependencyGraph() {
  const graph: Partial<Record<DomainName, Set<DomainName>>> = {};
  const relativeFiles = await readdir(sourceRoot, { recursive: true });
  for (const relativeFile of relativeFiles) {
    const isSourceFile = /\.[cm]?[jt]sx?$/u.test(relativeFile);
    const isDependencyFile = relativeFile.includes("node_modules/");
    const shouldSkipFile = !isSourceFile || isDependencyFile;
    if (shouldSkipFile) {
      continue;
    }
    const sourceFile = join(sourceRoot, relativeFile);
    const source = classifySourcePath(sourceFile);
    const isDomainSource = source.kind === "domain-layer" || source.kind === "domain-public";
    if (!isDomainSource) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const sourceText = await readFile(sourceFile, "utf8");
    for (const match of sourceText.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu)) {
      const targetFile = resolveImportTarget(sourceFile, match[1] ?? "");
      if (!targetFile) {
        continue;
      }
      const target = classifySourcePath(targetFile);
      const isCrossDomainPublicImport =
        target.kind === "domain-public" && target.domain !== source.domain;
      if (isCrossDomainPublicImport) {
        (graph[source.domain] ??= new Set()).add(target.domain);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(graph).map(([domain, dependencies]) => [domain, [...dependencies]]),
  );
}
