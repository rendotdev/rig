import { describe, expect, it } from "vite-plus/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import {
  classifySourcePath,
  dependencyRemediation,
  describeSourceClassification,
  resolveImportTarget,
  validateDependency,
} from "./architecture.ts";

class ArchitectureSourceSet {
  async codeFiles(): Promise<string[]> {
    const files = await Promise.all(
      ["src", "scripts", "test"].map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter(
            (path) => (path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".d.ts"),
          )
          .map((path) => `${root}/${path}`),
      ),
    );
    return files.flat().toSorted();
  }

  async implementationFiles(): Promise<string[]> {
    return (await this.codeFiles()).filter(
      (path) =>
        !path.startsWith("test/") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );
  }

  async effectImplementationFiles(): Promise<string[]> {
    return (await this.implementationFiles()).filter(
      (path) => !path.startsWith("src/tooling/") && !path.includes("/fixtures/"),
    );
  }

  async violations(
    pattern: RegExp,
    validate: (match: RegExpMatchArray) => boolean,
  ): Promise<string[]> {
    const files = await this.implementationFiles();
    const violations = await Promise.all(
      files.map(async (path) => {
        const source = await readFile(path, "utf8");
        return [...source.matchAll(pattern)]
          .filter((match) => !validate(match))
          .map((match) => `${path}:${this.line(source, match.index)}`);
      }),
    );
    return violations.flat();
  }

  async codeViolations(
    pattern: RegExp,
    validate: (match: RegExpMatchArray) => boolean,
  ): Promise<string[]> {
    const files = (await this.codeFiles()).filter(
      (path) => path !== "src/tooling/architecture/repository-architecture.test.ts",
    );
    const violations = await Promise.all(
      files.map(async (path) => {
        const source = await readFile(path, "utf8");
        return [...source.matchAll(pattern)]
          .filter((match) => !validate(match))
          .map((match) => `${path}:${this.line(source, match.index)}`);
      }),
    );
    return violations.flat();
  }

  private line(source: string, index: number | undefined): number {
    return source.slice(0, index ?? 0).split("\n").length;
  }
}

describe("architecture", () => {
  const sources = new ArchitectureSourceSet();

  it("classifies every production module and validates every internal import edge", async () => {
    const violations = await collectRepositoryArchitectureViolations(
      await sources.implementationFiles(),
    );
    expect(violations).toEqual([]);
  });

  it("forbids barrel files and re-export facades", async () => {
    const files = await sources.codeFiles();
    expect(files.filter((path) => /(?:^|\/)index\.tsx?$/u.test(path))).toEqual([]);
    expect(
      await sources.codeViolations(
        /^\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+["'][^"']+["']/gmu,
        () => false,
      ),
    ).toEqual([]);
  });

  it("forbids singleton construction vocabulary", async () => {
    expect(await sources.codeViolations(/\b[A-Za-z_$][\w$]*Singleton\b/g, () => false)).toEqual([]);
    expect(
      await sources.codeViolations(
        /^\s*export\s+const\s+[A-Za-z_$][\w$]*\s*=\s*new\s+/gmu,
        () => false,
      ),
    ).toEqual([]);
  });

  it("forbids generic Class suffixes", async () => {
    expect(await sources.codeViolations(/\bclass\s+[A-Za-z_$][\w$]*Class\b/g, () => false)).toEqual(
      [],
    );
  });

  it("uses architectural suffixes for implementation class declarations", async () => {
    const violations = await sources.violations(
      /\bclass\s+([A-Za-z_$][\w$]*)([\s\S]*?)(?=\{)/g,
      (match) =>
        /(?:Codec|Command|Config|Entrypoint|Error|File|Handle|Id|Index|Parser|Paths|Provider|Repo|Repository|Reporter|Resolver|Resource|Route|Runner|Runtime|Script|Service|Suite|Version)$/.test(
          match[1]!,
        ) ||
        /extends\s+(?:Context\.Service|Schema\.(?:Class|ErrorClass|TaggedClass|TaggedErrorClass))/.test(
          match[0],
        ),
    );
    expect(violations).toEqual([]);
  });

  it("keeps behavior on instances instead of static methods", async () => {
    const violations = await sources.violations(/\bstatic\s+[A-Za-z_$][\w$]*\s*[<(]/g, () => false);
    expect(violations).toEqual([]);
  });

  it("keeps production behavior inside canonical Effect services", async () => {
    const violations = (
      await Promise.all((await sources.effectImplementationFiles()).map(floatingBehaviorViolations))
    ).flat();
    expect(violations).toEqual([]);
  });

  it("gives every Context.Service its inline make and owned static layer", async () => {
    const violations = (
      await Promise.all((await sources.effectImplementationFiles()).map(effectServiceViolations))
    ).flat();
    expect(violations).toEqual([]);
  });

  it("executes Effects only at approved process and compatibility boundaries", async () => {
    const approved = new Set([
      "src/app/cli/composition-root.ts",
      "src/app/cli/entrypoint.ts",
      "src/app/cli/runtime-bootstrap.ts",
      "src/domains/collections/repo/sqlite/sqlite-collection-index.ts",
      "src/domains/collections/runtime/collection-handle-factory.ts",
      "src/domains/tools/runtime/runtime-support.ts",
      "src/domains/tools/runtime/tool-sdk.ts",
      "scripts/bench.ts",
      "scripts/release.ts",
      "scripts/smoke.ts",
    ]);
    const paths = (await sources.effectImplementationFiles()).filter((path) => !approved.has(path));
    const violations = (await Promise.all(paths.map(runtimeBoundaryViolations))).flat();
    expect(violations).toEqual([]);
  });

  it("uses Effect services and layers at reliability boundaries", async () => {
    const paths = [
      "src/app/cli/composition-root.ts",
      "src/domains/collections/runtime/collection-handle-factory.ts",
      "src/domains/scheduling/runtime/rig-cron.ts",
      "src/domains/settings/service/config-store.ts",
      "src/domains/tools/runtime/agent-instruction-sync.ts",
      "src/domains/tools/runtime/tool-collections.ts",
      "src/domains/tools/runtime/tool-loader.ts",
      "src/domains/tools/runtime/tool-runner.ts",
      "src/domains/updates/runtime/rig-updater.ts",
      "src/providers/filesystem/file-lock.ts",
      "src/providers/process/rig-shell-service.ts",
    ];
    const sourcesByPath = await Promise.all(
      paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    );
    for (const { source } of sourcesByPath) {
      expect(source).toContain("extends Context.Service");
      expect(source).toMatch(/(?:Layer\.|Layer<)/u);
    }

    expect(
      await sources.violations(
        /\b(?:ClassAdapter|ConstructorAdapter|defaultConstruction)\b|\bas unknown as\s+[A-Za-z_$][\w$]*Constructor\b/g,
        () => false,
      ),
    ).toEqual([]);

    const updateCheck = await readFile("src/domains/updates/service/npm-update-check.ts", "utf8");
    const updateTypes = await readFile("src/domains/updates/types/updates.ts", "utf8");
    expect(updateTypes).toContain("Schema.TaggedErrorClass");
    expect(updateCheck).toContain("Effect.retry");
    expect(updateCheck).toContain("Schedule.exponential");
  });

  it("has no legacy define construction vocabulary", async () => {
    const importingFiles = (
      await Promise.all(
        (
          await sources.implementationFiles()
        ).map(async (path) => ({
          path,
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(({ source }) => /from\s+["'][^"']*define["']/.test(source))
      .map(({ path }) => path);

    expect(importingFiles).toEqual([]);
    expect(await readdir("src")).not.toContain("define.ts");
  });

  it("keeps vendored source as a read-only reference", async () => {
    const violations = await sources.violations(
      /(?:from\s+|import\s*)["']([^"']*repos\/effect[^"']*)["']/g,
      () => false,
    );
    expect(violations).toEqual([]);
  });
});

async function collectRepositoryArchitectureViolations(paths: readonly string[]) {
  const sourcePaths = paths.filter((entry) => entry.startsWith("src/"));
  const violationGroups = await Promise.all(
    sourcePaths.map(async (path) => {
      const violations: string[] = [];
      const absolutePath = resolve(path);
      const classification = classifySourcePath(absolutePath);
      if (classification.kind === "invalid") {
        return [
          `${path}: ${describeSourceClassification(classification)}. Move this module into the canonical architecture layout.`,
        ];
      }
      const source = await readFile(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      for (const dependency of sourceDependencies(sourceFile)) {
        const targetPath = resolveImportTarget(absolutePath, dependency.specifier);
        if (!targetPath) continue;
        const decision = validateDependency(absolutePath, targetPath);
        if (decision.allowed) continue;
        const line = sourceFile.getLineAndCharacterOfPosition(
          dependency.node.getStart(sourceFile),
        ).line;
        violations.push(
          `${path}:${line + 1} ${describeSourceClassification(decision.source)} -> ${describeSourceClassification(decision.target)}. ${dependencyRemediation(decision)}`,
        );
      }
      return violations;
    }),
  );
  return violationGroups.flat();
}

function sourceDependencies(sourceFile: ts.SourceFile) {
  const dependencies: Array<{ specifier: string; node: ts.Node }> = [];
  const visit = (node: ts.Node) => {
    const isStaticModuleDependency =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier);
    if (isStaticModuleDependency) {
      dependencies.push({ specifier: node.moduleSpecifier.text, node: node.moduleSpecifier });
    }
    const isDynamicImport =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]);
    if (isDynamicImport) {
      dependencies.push({
        specifier: (node.arguments[0] as ts.StringLiteral).text,
        node: node.arguments[0] as ts.StringLiteral,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dependencies;
}

function isAllowedTopLevelFunction(path: string, name: string) {
  const isReactDeclaration =
    path.endsWith(".tsx") && (/^[A-Z]/u.test(name) || /^use[A-Z]/u.test(name));
  if (isReactDeclaration) {
    return true;
  }
  if (path === "src/domains/tools/runtime/tool-sdk.ts") {
    return name.startsWith("define") || name === "createRigToolKit";
  }
  const isCliBoundary =
    path === "src/app/cli/entrypoint.ts" ||
    path === "src/app/cli/composition-root.ts" ||
    path === "src/app/cli/runtime-bootstrap.ts";
  const isScriptEntrypoint = /^scripts\/(?:bench|release|smoke)\.ts$/u.test(path);
  return (
    (isCliBoundary || isScriptEntrypoint) &&
    new Set(["main", "program", "runCli", "runCliMain"]).has(name)
  );
}

async function floatingBehaviorViolations(path: string) {
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    inspectTopLevelStatement(path, sourceFile, statement, violations);
  }
  return violations;
}

function inspectTopLevelStatement(
  path: string,
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  violations: string[],
) {
  if (ts.isFunctionDeclaration(statement)) {
    const name = statement.name?.text ?? "anonymousFunction";
    if (!isAllowedTopLevelFunction(path, name)) {
      violations.push(sourceViolation(path, sourceFile, statement, name));
    }
  }
  if (ts.isVariableStatement(statement)) {
    inspectTopLevelVariables(path, sourceFile, statement, violations);
  }
  const isDisallowedClass =
    ts.isClassDeclaration(statement) && !isAllowedEffectClass(statement, sourceFile);
  if (isDisallowedClass) {
    violations.push(
      sourceViolation(path, sourceFile, statement, statement.name?.text ?? "AnonymousClass"),
    );
  }
}

function inspectTopLevelVariables(
  path: string,
  sourceFile: ts.SourceFile,
  statement: ts.VariableStatement,
  violations: string[],
) {
  for (const declaration of statement.declarationList.declarations) {
    const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "destructured";
    const initializer = declaration.initializer;
    const isCallable =
      initializer &&
      (ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer) ||
        isEffectFnExpression(initializer));
    const isDisallowedCallable = isCallable && !isAllowedTopLevelFunction(path, name);
    if (isDisallowedCallable) {
      violations.push(sourceViolation(path, sourceFile, statement, name));
    }
  }
}

async function effectServiceViolations(path: string) {
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const inspect = (node: ts.Node) => {
    const isNamedClass = ts.isClassDeclaration(node) && node.name !== undefined;
    if (isNamedClass) {
      inspectEffectServiceClass(path, sourceFile, node, violations);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return violations;
}

function inspectEffectServiceClass(
  path: string,
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration,
  violations: string[],
) {
  const declaration = node.getText(sourceFile);
  const isNotContextService = !/extends\s+Context\.Service\s*</u.test(declaration) || !node.name;
  if (isNotContextService) {
    return;
  }
  const name = node.name.text;
  const hasCanonicalName = name.endsWith("Service");
  const hasInlineApi = new RegExp(
    `extends\\s+Context\\.Service\\s*<\\s*${name}\\s*,\\s*\\{`,
    "u",
  ).test(declaration);
  const makePattern = name.endsWith("ConfigService")
    ? /\}\s*>\s*\(\s*\)\s*\([\s\S]*?make\s*:\s*Effect\.(?:gen|succeed|sync)\s*\(/u
    : /\}\s*>\s*\(\s*\)\s*\([\s\S]*?make\s*:\s*Effect\.gen\s*\(/u;
  const hasInlineMake = makePattern.test(declaration);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const hasOwnedLayer = new RegExp(
    `static\\s+readonly\\s+layer\\s*=\\s*Layer\\.(?:effect|scoped)\\(\\s*${escapedName}\\s*,\\s*${escapedName}\\.make\\s*,?\\s*\\)`,
    "u",
  ).test(declaration);
  const hasInvalidServiceContract =
    !hasCanonicalName || !hasInlineApi || !hasInlineMake || !hasOwnedLayer;
  if (hasInvalidServiceContract) {
    violations.push(sourceViolation(path, sourceFile, node, name));
  }
}

async function runtimeBoundaryViolations(path: string) {
  const source = await readFile(path, "utf8");
  return [
    ...source.matchAll(
      /\b(?:Effect\.(?:runCallback|runCallbackWith|runFork|runPromise|runPromiseExit|runPromiseWith|runSync|runSyncExit|runSyncWith)|ManagedRuntime\.make|BunRuntime\.runMain)\s*\(/gu,
    ),
  ].map((match) => `${path}:${source.slice(0, match.index).split("\n").length}`);
}

function sourceViolation(path: string, sourceFile: ts.SourceFile, node: ts.Node, name: string) {
  return `${path}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}:${name}`;
}

function isEffectFnExpression(expression: ts.Expression) {
  const isNotCurriedCall =
    !ts.isCallExpression(expression) || !ts.isCallExpression(expression.expression);
  if (isNotCurriedCall) {
    return false;
  }
  return expression.expression.expression.getText() === "Effect.fn";
}

function isAllowedEffectClass(declaration: ts.ClassDeclaration, sourceFile: ts.SourceFile) {
  const heritage =
    declaration.heritageClauses?.map((clause) => clause.getText(sourceFile)).join(" ") ?? "";
  return /extends\s+(?:Context\.Service|Schema\.(?:Class|ErrorClass|TaggedClass|TaggedErrorClass))\b/u.test(
    heritage,
  );
}
