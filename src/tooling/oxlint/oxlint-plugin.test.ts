import type { ESTree } from "@oxlint/plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createOxlintContext as createContext,
  createOxlintVisitor as createVisitor,
  meaningfulSource,
  oxlintImportNode as importNode,
} from "../../../test/fixtures/oxlint-rule-test-helpers.ts";
import {
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
} from "./oxlint-plugin.ts";

describe("Effect service contract", () => {
  it("accepts input Effect.fn operations and lazy spanned zero-argument operations", () => {
    const report = vi.fn<(message: unknown) => void>();
    const { node, source } = canonicalServiceNode();
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/service/example-service.ts", source, report),
    );

    visitor.ClassDeclaration?.(node as unknown as ESTree.Class);

    expect(report).not.toHaveBeenCalled();
  });

  it("reports detached APIs, detached make functions, and missing owned layers", () => {
    const report = vi.fn<(message: unknown) => void>();
    const node = {
      type: "ClassDeclaration",
      id: identifier("Reader"),
      superClass: call(
        call(
          member("Context", "Service"),
          [],
          [typeReference("Reader"), typeReference("ReaderShape")],
        ),
      ),
      body: { type: "ClassBody", body: [] },
    };
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/service/reader.ts", "", report),
    );

    visitor.ClassDeclaration?.(node as unknown as ESTree.Class);

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "serviceSuffix" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "inlineApi" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "inlineMake" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "staticLayer" }));
  });

  it("reports Effect.fn trace names that do not match the service operation", () => {
    const report = vi.fn<(message: unknown) => void>();
    const { node, source, readLabel } = canonicalServiceNode();
    readLabel.value = "Wrong.read";
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/service/example-service.ts", source, report),
    );

    visitor.ClassDeclaration?.(node as unknown as ESTree.Class);

    expect(report).toHaveBeenCalledWith({
      node: readLabel,
      messageId: "effectFnName",
      data: { expected: "ExampleService.read" },
    });
  });

  it("rejects deep and namespace Effect imports", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/service/example-service.ts", "", report),
    );

    visitor.ImportDeclaration?.({
      type: "ImportDeclaration",
      source: literal("effect/ManagedRuntime"),
      specifiers: [],
    } as unknown as ESTree.ImportDeclaration);
    visitor.ImportDeclaration?.({
      type: "ImportDeclaration",
      source: literal("effect"),
      specifiers: [{ type: "ImportNamespaceSpecifier" }],
    } as unknown as ESTree.ImportDeclaration);

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "deepEffectImport" }));
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "namedEffectImport" }),
    );
  });

  it("requires descriptive Layer suffixes for top-level layer bindings", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/runtime/tool-runtime.ts", "", report),
    );
    visitor.VariableDeclarator?.({
      type: "VariableDeclarator",
      id: identifier("toolRuntime"),
      init: call(member("Layer", "merge")),
    } as ESTree.VariableDeclarator);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "layerSuffix", data: { name: "toolRuntime" } }),
    );
  });

  it("requires tagged operational failures to use the Error suffix", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/tools/types/failures.ts", "", report),
    );
    visitor.ClassDeclaration?.({
      type: "ClassDeclaration",
      id: identifier("ToolFailure"),
      superClass: call(call(member("Schema", "TaggedErrorClass"))),
      body: { type: "ClassBody", body: [] },
    } as unknown as ESTree.Class);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "taggedErrorSuffix",
        data: { name: "ToolFailure" },
      }),
    );
  });
});

describe("Effect behavior boundaries", () => {
  it("rejects floating functions, callable constants, constructions, and ordinary classes", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      noFloatingBehaviorRule,
      createContext("/repo/src/domains/tools/service/floating.ts", "", report),
    );

    visitor.FunctionDeclaration?.({
      type: "FunctionDeclaration",
      id: identifier("loadTool"),
    } as ESTree.Function);
    visitor.VariableDeclarator?.({
      type: "VariableDeclarator",
      id: identifier("readTool"),
      init: { type: "ArrowFunctionExpression" },
    } as ESTree.VariableDeclarator);
    visitor.ClassDeclaration?.({
      type: "ClassDeclaration",
      id: identifier("ToolManager"),
      superClass: null,
    } as ESTree.Class);
    visitor.ClassExpression?.({
      type: "ClassExpression",
      id: identifier("InlineManager"),
      superClass: null,
    } as ESTree.Class);
    visitor.VariableDeclarator?.({
      type: "VariableDeclarator",
      id: identifier("client"),
      init: { type: "NewExpression", callee: identifier("Client") },
    } as ESTree.VariableDeclarator);

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "floatingFunction" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "floatingCallable" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "behavioralClass" }));
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "floatingConstruction" }),
    );
  });

  it("allows React components, Schema data classes, and test callbacks", () => {
    const reactReport = vi.fn<(message: unknown) => void>();
    const reactVisitor = createVisitor(
      noFloatingBehaviorRule,
      createContext("/repo/src/domains/tools/ui/tool-view.tsx", "", reactReport),
    );
    reactVisitor.FunctionDeclaration?.({
      type: "FunctionDeclaration",
      id: identifier("ToolView"),
    } as ESTree.Function);
    reactVisitor.ClassDeclaration?.({
      type: "ClassDeclaration",
      id: identifier("ToolError"),
      superClass: call(member("Schema", "TaggedErrorClass")),
    } as ESTree.Class);

    const testReport = vi.fn<(message: unknown) => void>();
    const testVisitor = createVisitor(
      noFloatingBehaviorRule,
      createContext("/repo/src/domains/tools/service/tool.test.ts", "", testReport),
    );
    testVisitor.FunctionDeclaration?.({
      type: "FunctionDeclaration",
      id: identifier("fixture"),
    } as ESTree.Function);

    expect(reactReport).not.toHaveBeenCalled();
    expect(testReport).not.toHaveBeenCalled();
  });

  it("keeps Effect runners outside application services", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectRuntimeBoundaryRule,
      createContext("/repo/src/domains/tools/service/run-tool.ts", "", report),
    );
    const node = call(member("Effect", "runPromise"));

    visitor.CallExpression?.(node as ESTree.CallExpression);

    expect(report).toHaveBeenCalledWith({
      node,
      messageId: "runtimeBoundary",
      data: { call: "Effect.runPromise" },
    });
  });

  it("allows the explicit Promise collection-handle adapter boundary", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectRuntimeBoundaryRule,
      createContext(
        "/repo/src/domains/collections/runtime/collection-handle-factory.ts",
        "",
        report,
      ),
    );

    visitor.CallExpression?.(call(member("Effect", "runPromise")) as ESTree.CallExpression);

    expect(report).not.toHaveBeenCalled();
  });

  it("allows the explicit Promise SQLite collection-index adapter boundary", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectRuntimeBoundaryRule,
      createContext(
        "/repo/src/domains/collections/repo/sqlite/sqlite-collection-index.ts",
        "",
        report,
      ),
    );

    visitor.CallExpression?.(call(member("Effect", "runPromise")) as ESTree.CallExpression);

    expect(report).not.toHaveBeenCalled();
  });

  it("requires ManagedRuntime disposal at approved compatibility boundaries", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      effectRuntimeBoundaryRule,
      createContext("/repo/src/domains/tools/runtime/tool-sdk.ts", "", report),
    );
    const declaration = {
      type: "VariableDeclarator",
      id: identifier("runtime"),
      init: call(member("ManagedRuntime", "make")),
    };

    visitor.VariableDeclarator?.(declaration as ESTree.VariableDeclarator);
    visitor["Program:exit"]?.({ type: "Program" } as ESTree.Program);

    expect(report).toHaveBeenCalledWith({
      node: declaration,
      messageId: "undisposedRuntime",
      data: { name: "runtime" },
    });
  });
});

describe("barrel prohibition", () => {
  it("reports index modules and every external re-export facade", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      noBarrelFilesRule,
      createContext("/repo/src/domains/tools/index.ts", "", report),
    );

    visitor.Program?.({ type: "Program" } as ESTree.Program);
    visitor.ExportAllDeclaration?.({
      type: "ExportAllDeclaration",
      source: literal("./tool.ts"),
    } as unknown as ESTree.ExportAllDeclaration);

    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "indexFile" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ messageId: "reExport" }));
  });
});

describe("architecture dependency rules", () => {
  it("reports a forbidden layer dependency with remediation", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      layerBoundariesRule,
      createContext("/repo/src/domains/tools/service/run-tool.ts", "", report),
    );

    visitor.ImportDeclaration?.(importNode("../runtime/server.ts") as ESTree.ImportDeclaration);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ value: "../runtime/server.ts" }),
        messageId: "invalidDependency",
        data: expect.objectContaining({
          source: "tools/service",
          target: "tools/runtime",
        }),
      }),
    );
    expect(layerBoundariesRule.meta?.messages?.invalidDependency).toContain(
      "{{source}} cannot import {{target}}",
    );
  });

  it("allows dependencies on earlier layers", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      layerBoundariesRule,
      createContext("/repo/src/domains/tools/service/run-tool.ts", "", report),
    );

    visitor.ImportDeclaration?.(importNode("../repo/store.ts") as ESTree.ImportDeclaration);

    expect(report).not.toHaveBeenCalled();
  });

  it("allows direct module imports and rejects barrel imports", () => {
    const appReport = vi.fn<(message: unknown) => void>();
    const appVisitor = createVisitor(
      domainPublicApiRule,
      createContext("/repo/src/app/cli/cli.ts", "", appReport),
    );
    appVisitor.ImportDeclaration?.(
      importNode("../../domains/tools/service/run-tool.ts") as ESTree.ImportDeclaration,
    );

    const barrelReport = vi.fn<(message: unknown) => void>();
    const barrelVisitor = createVisitor(
      domainPublicApiRule,
      createContext("/repo/src/app/cli/cli.ts", "", barrelReport),
    );
    barrelVisitor.ImportDeclaration?.(
      importNode("../../domains/tools/index.ts") as ESTree.ImportDeclaration,
    );

    expect(appReport).not.toHaveBeenCalled();
    expect(barrelReport).toHaveBeenCalledOnce();
    expect(domainPublicApiRule.meta?.messages?.invalidDependency).toContain(
      "Barrel index.ts files are forbidden",
    );
  });

  it("allows direct domain module imports", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      domainPublicApiRule,
      createContext("/repo/src/app/cli/cli.ts", "", report),
    );

    visitor.ImportDeclaration?.(
      importNode("../../domains/tools/service/run-tool.ts") as ESTree.ImportDeclaration,
    );

    expect(report).not.toHaveBeenCalled();
  });
});

describe("source location rule", () => {
  it("reports unknown domain layers with a concrete destination", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      sourceLocationRule,
      createContext("/repo/src/domains/tools/helpers/helper.ts", "", report),
    );

    visitor.Program?.({ type: "Program" } as ESTree.Program);

    expect(report).toHaveBeenCalledWith({
      node: { type: "Program" },
      messageId: "invalidLayer",
    });
    expect(sourceLocationRule.meta?.messages?.invalidLayer).toContain("types, config, repo");
  });

  it("rejects new ad hoc source locations", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      sourceLocationRule,
      createContext("/repo/src/helpers/helper.ts", "", report),
    );

    visitor.Program?.({ type: "Program" } as ESTree.Program);

    expect(report).toHaveBeenCalledWith({
      node: { type: "Program" },
      messageId: "invalidLocation",
    });
  });
});

describe("size rules", () => {
  it("reports production files above 400 meaningful lines", () => {
    const report = vi.fn<(message: unknown) => void>();
    const text = meaningfulSource(401);
    const visitor = createVisitor(
      maxFileLinesRule,
      createContext("/repo/src/domains/tools/service/run-tool.ts", text, report),
    );

    visitor.Program?.({ type: "Program" } as ESTree.Program);

    expect(report).toHaveBeenCalledWith({
      node: { type: "Program" },
      messageId: "tooLarge",
      data: { actual: 401, limit: 400 },
    });
    expect(maxFileLinesRule.meta?.messages?.tooLarge).toContain("domain responsibility or layer");
  });

  it("allows test files up to 600 meaningful lines", () => {
    const report = vi.fn<(message: unknown) => void>();
    const text = meaningfulSource(600);
    const visitor = createVisitor(
      maxFileLinesRule,
      createContext("/repo/src/domains/tools/service/run-tool.test.ts", text, report),
    );

    visitor.Program?.({ type: "Program" } as ESTree.Program);

    expect(report).not.toHaveBeenCalled();
  });

  it("does not count blank or comment-only lines", () => {
    const report = vi.fn<(message: unknown) => void>();
    const comment = "// architecture context";
    const text = `${meaningfulSource(400)}\n\n${comment}`;
    const context = createContext("/repo/src/domains/tools/service/run-tool.ts", text, report, [
      {
        type: "Line",
        value: " architecture context",
        range: [text.lastIndexOf(comment), text.length],
      },
    ]);
    const visitor = createVisitor(maxFileLinesRule, context);

    visitor.Program?.({ type: "Program" } as ESTree.Program);

    expect(report).not.toHaveBeenCalled();
  });

  it("reports functions and methods above 80 meaningful lines", () => {
    const report = vi.fn<(message: unknown) => void>();
    const text = meaningfulSource(81);
    const visitor = createVisitor(
      maxFunctionLinesRule,
      createContext("/repo/src/domains/tools/runtime/tool-runtime.ts", text, report),
    );
    const node = { type: "FunctionDeclaration", range: [0, text.length] };

    visitor.FunctionDeclaration?.(node as ESTree.Function);

    expect(report).toHaveBeenCalledWith({
      node,
      messageId: "tooLarge",
      data: { actual: 81, limit: 80 },
    });
    expect(maxFunctionLinesRule.meta?.messages?.tooLarge).toContain("appropriate runtime");
  });

  it("allows describe callbacks to organize large test suites", () => {
    const report = vi.fn<(message: unknown) => void>();
    const text = meaningfulSource(81);
    const visitor = createVisitor(
      maxFunctionLinesRule,
      createContext("/repo/src/domains/tools/service/run-tool.test.ts", text, report),
    );
    const node = {
      type: "ArrowFunctionExpression",
      range: [0, text.length],
      parent: { type: "CallExpression", callee: { type: "Identifier", name: "describe" } },
    };

    visitor.ArrowFunctionExpression?.(node as ESTree.ArrowFunctionExpression);

    expect(report).not.toHaveBeenCalled();
  });
});

describe("named compound if condition rule", () => {
  it("preserves the existing compound-condition invariant", () => {
    const report = vi.fn<(message: unknown) => void>();
    const visitor = createVisitor(
      namedCompoundIfConditionRule,
      createContext("/repo/src/domains/tools/service/run-tool.ts", "", report),
    );

    visitor.IfStatement?.({ test: { type: "LogicalExpression" } } as ESTree.IfStatement);

    expect(report).toHaveBeenCalledWith({
      node: { type: "LogicalExpression" },
      messageId: "nameCondition",
    });
  });
});

function canonicalServiceNode(options: { refreshEffect?: object } = {}) {
  const source =
    "readonly read: (input: string) => Effect.Effect<string>; readonly refresh: Effect.Effect<void>;";
  const readStart = source.indexOf("readonly read");
  const readEnd = source.indexOf(";", readStart) + 1;
  const refreshStart = source.indexOf("readonly refresh");
  const readLabel = literal("ExampleService.read") as { type: string; value: string };
  const readEffect = effectFn(readLabel, true);
  const refreshEffect =
    options.refreshEffect ??
    call(
      member(
        call(member("Effect", "gen"), [{ type: "FunctionExpression", generator: true }]),
        "pipe",
      ),
      [call(member("Effect", "withSpan"), [literal("ExampleService.refresh")])],
    );
  const make = canonicalMake(readEffect, refreshEffect);
  const api = canonicalApi(readStart, readEnd, refreshStart, source.length);
  const serviceFactory = call(
    member("Context", "Service"),
    [],
    [typeReference("ExampleService"), api],
  );
  const node = {
    type: "ClassDeclaration",
    id: identifier("ExampleService"),
    superClass: call(serviceFactory, [
      literal("@rendotdev/rig/example/ExampleService"),
      { type: "ObjectExpression", properties: [property("make", make)] },
    ]),
    body: {
      type: "ClassBody",
      body: [
        {
          type: "PropertyDefinition",
          static: true,
          readonly: true,
          key: identifier("layer"),
          value: call(member("Layer", "effect"), [
            identifier("ExampleService"),
            member("ExampleService", "make"),
          ]),
        },
      ],
    },
  };
  return { node, source, readLabel, refreshMember: api.members[1]! };
}

function canonicalMake(readEffect: object, refreshEffect: object) {
  const returnedApi = {
    type: "ReturnStatement",
    argument: {
      type: "TSAsExpression",
      expression: {
        type: "ObjectExpression",
        properties: [
          property("read", identifier("read")),
          property("refresh", identifier("refresh")),
        ],
      },
      typeAnnotation: typeReference("const"),
    },
  };
  return call(member("Effect", "gen"), [
    {
      type: "FunctionExpression",
      generator: true,
      body: {
        type: "BlockStatement",
        body: [
          variable("normalize", { type: "ArrowFunctionExpression" }),
          variable("read", readEffect),
          variable("refresh", refreshEffect),
          returnedApi,
        ],
      },
    },
  ]);
}

function canonicalApi(readStart: number, readEnd: number, refreshStart: number, sourceEnd: number) {
  return {
    type: "TSTypeLiteral",
    members: [
      {
        type: "TSPropertySignature",
        readonly: true,
        key: identifier("read"),
        range: [readStart, readEnd],
        typeAnnotation: {
          type: "TSTypeAnnotation",
          typeAnnotation: { type: "TSFunctionType", params: [identifier("input")] },
        },
      },
      {
        type: "TSPropertySignature",
        readonly: true,
        key: identifier("refresh"),
        range: [refreshStart, sourceEnd],
        typeAnnotation: {
          type: "TSTypeAnnotation",
          typeAnnotation: typeReference("Effect.Effect"),
        },
      },
    ],
  };
}

function identifier(name: string) {
  return { type: "Identifier", name };
}

function literal(value: string) {
  return { type: "Literal", value };
}

function member(object: string | object, memberName: string) {
  return {
    type: "MemberExpression",
    computed: false,
    object: typeof object === "string" ? identifier(object) : object,
    property: identifier(memberName),
  };
}

function call(callee: object, arguments_: object[] = [], typeArguments?: object[]) {
  return {
    type: "CallExpression",
    callee,
    arguments: arguments_,
    ...(typeArguments
      ? { typeArguments: { type: "TSTypeParameterInstantiation", params: typeArguments } }
      : {}),
  };
}

function property(name: string, value: object) {
  return { type: "Property", key: identifier(name), value, computed: false };
}

function variable(name: string, init: object) {
  return {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [{ type: "VariableDeclarator", id: identifier(name), init }],
  };
}

function typeReference(name: string, typeArguments?: object[]) {
  return {
    type: "TSTypeReference",
    typeName: identifier(name),
    ...(typeArguments
      ? { typeArguments: { type: "TSTypeParameterInstantiation", params: typeArguments } }
      : {}),
  };
}

function effectFn(label: object, generator: boolean) {
  return call(call(member("Effect", "fn"), [label]), [{ type: "FunctionExpression", generator }]);
}
