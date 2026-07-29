import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import ts from "typescript";
import {
  allowedDomainDependencies,
  allowedLayerDependencies,
  classifySourcePath,
  type DomainName,
  domainLayers,
  domainNames,
  fileLineLimitForPath,
  findDomainDependencyCycle,
  findLayerDependencyCycle,
  functionLineLimitForPath,
  resolveImportTarget,
  validateArchitectureModel,
  validateDependency,
} from "./architecture.ts";

const root = "/repo/src";
const sourceRoot = resolve(import.meta.dirname, "../..");

describe("architecture model", () => {
  it("defines an acyclic dependency graph", () => {
    expect(validateArchitectureModel()).toEqual([]);
    expect(allowedLayerDependencies).toEqual({
      types: ["types"],
      config: ["types", "config"],
      repo: ["types", "config", "repo"],
      service: ["types", "config", "repo", "service"],
      runtime: ["types", "config", "service", "runtime"],
      ui: ["types", "config", "service", "runtime", "ui"],
    });
    expect(allowedDomainDependencies).toEqual({
      collections: [],
      registry: ["settings"],
      scheduling: ["settings", "tools"],
      settings: [],
      tools: ["collections", "registry", "settings"],
      updates: ["settings"],
    });
  });

  it("keeps production and test limits strict without migration overrides", () => {
    expect(
      fileLineLimitForPath("/repo/src/domains/collections/types/tool-collection.ts", false),
    ).toBe(400);
    expect(functionLineLimitForPath("/repo/src/domains/scheduling/runtime/rig-cron.ts")).toBe(80);
    expect(fileLineLimitForPath("/repo/src/domains/tools/runtime/tool-runner.test.ts", true)).toBe(
      600,
    );
    expect(functionLineLimitForPath("/repo/src/domains/tools/runtime/tool-runner.test.ts")).toBe(
      80,
    );
  });

  it("detects a dependency cycle", () => {
    const cyclicGraph = { ...allowedLayerDependencies, types: ["types", "ui"] } as const;

    expect(findLayerDependencyCycle(cyclicGraph)).toEqual(["types", "ui", "types"]);
  });

  it("defines unique durable business domains", () => {
    expect(new Set(domainNames).size).toBe(domainNames.length);
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
      expect(decision.allowed).toBe(["repo", "service", "runtime"].includes(layer));
    }
  });
});

describe("dependency boundaries", () => {
  it("lets app wiring import concrete domain modules", () => {
    expect(
      validateDependency(`${root}/app/cli/cli.ts`, `${root}/domains/tools/service/run-tool.ts`)
        .allowed,
    ).toBe(true);
    expect(
      validateDependency(`${root}/app/cli/main.tsx`, `${root}/domains/tools/ui/tool-ui.ts`).allowed,
    ).toBe(true);
    expect(
      validateDependency(`${root}/app/cli/cli.ts`, `${root}/domains/tools/repo/tool-store.ts`)
        .allowed,
    ).toBe(false);
  });

  it("allows only declared cross-domain contracts at forward layers", () => {
    expect(
      validateDependency(
        `${root}/domains/tools/service/run-tool.ts`,
        `${root}/domains/settings/repo/store.ts`,
      ).allowed,
    ).toBe(false);
    expect(
      validateDependency(
        `${root}/domains/tools/service/run-tool.ts`,
        `${root}/domains/settings/service/settings.ts`,
      ).allowed,
    ).toBe(true);
    for (const layer of ["types", "config", "repo"] as const) {
      expect(
        validateDependency(
          `${root}/domains/tools/${layer}/source.ts`,
          `${root}/domains/settings/service/settings.ts`,
        ).allowed,
      ).toBe(false);
    }
    expect(
      validateDependency(
        `${root}/domains/scheduling/service/schedule.ts`,
        `${root}/domains/collections/service/collections.ts`,
      ).allowed,
    ).toBe(false);
    expect(
      validateDependency(
        `${root}/domains/scheduling/runtime/scheduler.ts`,
        `${root}/domains/tools/runtime/tool-runner.ts`,
      ).allowed,
    ).toBe(true);
  });

  it("isolates providers, utilities, tooling, and app wiring", () => {
    expect(
      validateDependency(
        `${root}/providers/filesystem/filesystem.ts`,
        `${root}/domains/tools/service/tool-service.ts`,
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
        `${root}/domains/tools/ui/tool.tsx`,
        `${root}/providers/filesystem/filesystem.ts`,
      ).allowed,
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

  it("rejects index entrypoints because barrel files are forbidden", () => {
    expect(classifySourcePath(`${root}/domains/tools/index.ts`)).toEqual({
      kind: "invalid",
      reason: "source-location",
    });
    expect(classifySourcePath(`${root}/domains/tools/ui/index.ts`)).toEqual({
      kind: "invalid",
      reason: "source-location",
    });
  });

  it("rejects legacy roots and new ad hoc locations", () => {
    for (const path of [
      "tools/run.ts",
      "runtime/process/shell.ts",
      "cli.ts",
      "helpers/helper.ts",
    ]) {
      expect(classifySourcePath(`${root}/${path}`)).toEqual({
        kind: "invalid",
        reason: "source-location",
      });
    }
  });

  it("resolves local imports without treating packages as source dependencies", () => {
    expect(
      resolveImportTarget(`${root}/app/cli/cli.ts`, "../../domains/tools/service/tool.ts"),
    ).toBe(`${root}/domains/tools/service/tool.ts`);
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
    const isDomainSource = source.kind === "domain-layer";
    if (!isDomainSource) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const sourceText = await readFile(sourceFile, "utf8");
    for (const specifier of importSpecifiers(relativeFile, sourceText)) {
      const targetFile = resolveImportTarget(sourceFile, specifier);
      if (!targetFile) {
        continue;
      }
      const target = classifySourcePath(targetFile);
      const isCrossDomainImport = target.kind === "domain-layer" && target.domain !== source.domain;
      if (isCrossDomainImport) {
        (graph[source.domain] ??= new Set()).add(target.domain);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(graph).map(([domain, dependencies]) => [domain, [...dependencies]]),
  );
}

function importSpecifiers(path: string, source: string) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    const isStaticModuleDependency =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier);
    if (isStaticModuleDependency) {
      specifiers.push(node.moduleSpecifier.text);
    }
    const isDynamicImport =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]);
    if (isDynamicImport) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
