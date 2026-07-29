import type { Context, ESTree, Rule } from "@oxlint/plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { effectServiceContractRule } from "./oxlint-plugin.ts";

describe("Effect callable payload contract", () => {
  it("rejects Effect success objects with callable members", () => {
    const report = vi.fn<(message: unknown) => void>();
    const service = serviceNode(
      typeReference("Effect.Effect", [
        {
          type: "TSTypeLiteral",
          members: [
            {
              type: "TSPropertySignature",
              readonly: true,
              key: identifier("close"),
              typeAnnotation: {
                type: "TSTypeAnnotation",
                typeAnnotation: { type: "TSFunctionType", params: [] },
              },
            },
          ],
        },
      ]),
      spanned(call(member("Effect", "succeed"), [literal(undefined)])),
    );
    const visitor = createVisitor(effectServiceContractRule, createContext(service.source, report));

    visitor.ClassDeclaration?.(service.node as unknown as ESTree.Class);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "callableEffectPayload",
        data: { name: "resource" },
      }),
    );
  });

  it("rejects lazy Effects that return locally-owned callable containers", () => {
    const report = vi.fn<(message: unknown) => void>();
    const callable = call(member("Effect", "sync"), [
      {
        type: "ArrowFunctionExpression",
        body: {
          type: "ObjectExpression",
          properties: [property("close", { type: "ArrowFunctionExpression" })],
        },
      },
    ]);
    const service = serviceNode(
      typeReference("Effect.Effect", [typeReference("ExternalHandle")]),
      spanned(callable),
    );
    const visitor = createVisitor(effectServiceContractRule, createContext(service.source, report));

    visitor.ClassDeclaration?.(service.node as unknown as ESTree.Class);

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "callableEffectValue",
        data: { name: "resource" },
      }),
    );
  });
});

function serviceNode(apiType: object, implementation: object) {
  const source = "readonly resource: Effect.Effect<ExternalHandle>;";
  const serviceFactory = call(
    member("Context", "Service"),
    [],
    [
      typeReference("HandleService"),
      {
        type: "TSTypeLiteral",
        members: [
          {
            type: "TSPropertySignature",
            readonly: true,
            key: identifier("resource"),
            range: [0, source.length],
            typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: apiType },
          },
        ],
      },
    ],
  );
  const make = call(member("Effect", "gen"), [
    {
      type: "FunctionExpression",
      generator: true,
      body: {
        type: "BlockStatement",
        body: [
          variable("resource", implementation),
          {
            type: "ReturnStatement",
            argument: {
              type: "TSAsExpression",
              expression: {
                type: "ObjectExpression",
                properties: [property("resource", identifier("resource"))],
              },
              typeAnnotation: typeReference("const"),
            },
          },
        ],
      },
    },
  ]);
  return {
    source,
    node: {
      type: "ClassDeclaration",
      id: identifier("HandleService"),
      superClass: call(serviceFactory, [
        literal("@rendotdev/rig/test/HandleService"),
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
              identifier("HandleService"),
              member("HandleService", "make"),
            ]),
          },
        ],
      },
    },
  };
}

function spanned(effect: object) {
  return call(member(effect, "pipe"), [
    call(member("Effect", "withSpan"), [literal("HandleService.resource")]),
  ]);
}

function createContext(source: string, report: ReturnType<typeof vi.fn>) {
  return {
    filename: "/repo/src/domains/tools/service/handle-service.ts",
    report,
    sourceCode: { text: source, getAllComments: () => [] },
  } as unknown as Context;
}

function createVisitor(rule: Rule, context: Context) {
  if (!rule.create) throw new Error("The Oxlint rule must provide a create visitor.");
  return rule.create(context);
}

function identifier(name: string) {
  return { type: "Identifier", name };
}

function literal(value: unknown) {
  return { type: "Literal", value };
}

function member(object: string | object, name: string) {
  return {
    type: "MemberExpression",
    computed: false,
    object: typeof object === "string" ? identifier(object) : object,
    property: identifier(name),
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
