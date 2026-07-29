import type { Context, ESTree, Rule } from "@oxlint/plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { effectServiceContractRule } from "./oxlint-plugin.ts";

describe("Effect ConfigService contract", () => {
  it("allows readonly non-callable data only on ConfigService APIs", () => {
    const report = vi.fn<(message: unknown) => void>();
    const source = "readonly homeDir: string;";
    const make = call(member("Effect", "succeed"), [
      {
        type: "TSAsExpression",
        expression: {
          type: "ObjectExpression",
          properties: [property("homeDir", literal("/tmp/rig"))],
        },
        typeAnnotation: typeReference("const"),
      },
    ]);
    const node = serviceNode("PathsConfigService", source, make);
    const visitor = createVisitor(
      effectServiceContractRule,
      createContext("/repo/src/domains/settings/config/paths-config.ts", source, report),
    );

    visitor.ClassDeclaration?.(node as unknown as ESTree.Class);

    expect(report).not.toHaveBeenCalled();
  });
});

function serviceNode(name: string, source: string, make: object) {
  const serviceFactory = call(
    member("Context", "Service"),
    [],
    [
      typeReference(name),
      {
        type: "TSTypeLiteral",
        members: [
          {
            type: "TSPropertySignature",
            readonly: true,
            key: identifier("homeDir"),
            range: [0, source.length],
            typeAnnotation: {
              type: "TSTypeAnnotation",
              typeAnnotation: { type: "TSStringKeyword" },
            },
          },
        ],
      },
    ],
  );
  return {
    type: "ClassDeclaration",
    id: identifier(name),
    superClass: call(serviceFactory, [
      literal(`@rendotdev/rig/test/${name}`),
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
          value: call(member("Layer", "effect"), [identifier(name), member(name, "make")]),
        },
      ],
    },
  };
}

function createContext(filename: string, text: string, report: ReturnType<typeof vi.fn>) {
  return {
    filename,
    report,
    sourceCode: { text, getAllComments: () => [] },
  } as unknown as Context;
}

function createVisitor(rule: Rule, context: Context) {
  if (!rule.create) {
    throw new Error("The Oxlint rule must provide a create visitor.");
  }
  return rule.create(context);
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

function typeReference(name: string) {
  return { type: "TSTypeReference", typeName: identifier(name) };
}
