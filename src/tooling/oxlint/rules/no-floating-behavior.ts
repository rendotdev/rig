import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";
import {
  asEffectNode,
  identifierName,
  isCallTo,
  isEffectPolicyPath,
  isTopLevelDeclaration,
  memberPath,
  sourcePathKey,
  unwrapExpression,
} from "./effect-ast.ts";

const compatibilityCallableNames = new Set([
  "createRigToolKit",
  "defineTool",
  "main",
  "program",
  "runCli",
  "runCliMain",
]);

export const noFloatingBehaviorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep production behavior inside Effect Context.Service implementations while allowing declarative language and framework constructs.",
    },
    messages: {
      floatingFunction:
        "Move '{{name}}' into a Context.Service make block. Use a local const arrow for pure private logic, or Effect.fn(\"ServiceName.{{name}}\") for effectful logic.",
      floatingCallable:
        "Move the callable '{{name}}' into a Context.Service make block and expose it through the service's returned readonly API.",
      behavioralClass:
        "Replace '{{name}}' with Context.Service for behavior, or Schema.Class, Schema.TaggedClass, Schema.ErrorClass, or Schema.TaggedErrorClass for data and typed errors.",
      floatingConstruction:
        "Move module-level construction of '{{name}}' into a Context.Service make block so the resource is replaceable and its lifetime is owned by a Layer.",
      functionExpression:
        "Use a const arrow for pure private logic. Function expressions are reserved for generator callbacks passed directly to Effect.gen or Effect.fn.",
    },
  },
  create(context) {
    if (!isEffectPolicyPath(context.filename)) {
      return {};
    }
    const filePath = sourcePathKey(context.filename);

    return {
      FunctionDeclaration(node: ESTree.Function) {
        const name = node.id?.name ?? "anonymousFunction";
        const isAllowedFunction =
          isAllowedReactDeclaration(filePath, name) || isCompatibilityCallable(filePath, name);
        if (isAllowedFunction) {
          return;
        }
        context.report({ node, messageId: "floatingFunction", data: { name } });
      },
      FunctionExpression(node: ESTree.Function) {
        if (isEffectGeneratorCallback(node)) {
          return;
        }
        context.report({ node, messageId: "functionExpression" });
      },
      VariableDeclarator(node: ESTree.VariableDeclarator) {
        if (!isTopLevelDeclaration(node)) {
          return;
        }
        const name = identifierName(node.id) ?? "anonymousCallable";
        const isAllowedCallable =
          isAllowedReactDeclaration(filePath, name) || isCompatibilityCallable(filePath, name);
        if (isAllowedCallable) {
          return;
        }
        const init = unwrapExpression(node.init);
        const isDirectCallable =
          init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression" ||
          isEffectFnCall(init);
        if (isDirectCallable) {
          context.report({ node, messageId: "floatingCallable", data: { name } });
        }
        if (init?.type === "NewExpression") {
          context.report({ node, messageId: "floatingConstruction", data: { name } });
        }
      },
      ClassDeclaration(node: ESTree.Class) {
        const name = node.id?.name ?? "AnonymousClass";
        const isAllowedClass = isContextService(node) || isSchemaClass(node);
        if (isAllowedClass) {
          return;
        }
        context.report({ node, messageId: "behavioralClass", data: { name } });
      },
      ClassExpression(node: ESTree.Class) {
        const name = node.id?.name ?? "AnonymousClass";
        const isAllowedClass = isContextService(node) || isSchemaClass(node);
        if (isAllowedClass) {
          return;
        }
        context.report({ node, messageId: "behavioralClass", data: { name } });
      },
    };
  },
});

function isEffectGeneratorCallback(node: ESTree.Function) {
  const parent = asEffectNode(node.parent);
  if (parent?.type !== "CallExpression") {
    return false;
  }
  if (isCallTo(parent, "Effect.gen")) {
    return node.generator;
  }
  const innerCall = asEffectNode(parent.callee);
  return innerCall?.type === "CallExpression" && isCallTo(innerCall, "Effect.fn") && node.generator;
}

function isContextService(node: ESTree.Class) {
  const outerCall = unwrapExpression(node.superClass);
  if (outerCall?.type !== "CallExpression") {
    return false;
  }
  const serviceFactory = unwrapExpression(outerCall.callee);
  return (
    serviceFactory?.type === "CallExpression" &&
    memberPath(serviceFactory.callee) === "Context.Service"
  );
}

function isSchemaClass(node: ESTree.Class) {
  let expression = unwrapExpression(node.superClass);
  for (let depth = 0; expression && depth < 4; depth++) {
    if (expression.type !== "CallExpression") {
      return false;
    }
    const path = memberPath(expression.callee);
    const isSchemaClassFactory =
      path === "Schema.Class" ||
      path === "Schema.TaggedClass" ||
      path === "Schema.ErrorClass" ||
      path === "Schema.TaggedErrorClass";
    if (isSchemaClassFactory) {
      return true;
    }
    expression = unwrapExpression(expression.callee);
  }
  return false;
}

function isEffectFnCall(value: unknown) {
  const outerCall = unwrapExpression(value);
  if (outerCall?.type !== "CallExpression") {
    return false;
  }
  return isCallTo(outerCall.callee, "Effect.fn");
}

function isAllowedReactDeclaration(filePath: string, name: string) {
  const isReactModule = filePath.endsWith(".tsx");
  return isReactModule && (/^[A-Z]/u.test(name) || /^use[A-Z]/u.test(name));
}

function isCompatibilityCallable(filePath: string, name: string) {
  const isSdkModule = filePath === "src/domains/tools/runtime/tool-sdk.ts";
  const isCliBoundary =
    filePath === "src/app/cli/entrypoint.ts" ||
    filePath === "src/app/cli/composition-root.ts" ||
    filePath === "src/app/cli/runtime-bootstrap.ts";
  const isScriptEntrypoint = /^scripts\/(?:bench|release|smoke)\.ts$/u.test(filePath);
  return (
    (isSdkModule && (name.startsWith("define") || name === "createRigToolKit")) ||
    ((isCliBoundary || isScriptEntrypoint) && compatibilityCallableNames.has(name))
  );
}
