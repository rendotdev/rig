import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";
import {
  identifierName,
  isCallTo,
  isEffectPolicyPath,
  isTestOrFixturePath,
  memberPath,
  sourcePathKey,
  unwrapExpression,
} from "./effect-ast.ts";

const runtimeCalls = new Set([
  "BunRuntime.runMain",
  "Effect.runFork",
  "Effect.runCallback",
  "Effect.runCallbackWith",
  "Effect.runPromise",
  "Effect.runPromiseExit",
  "Effect.runPromiseWith",
  "Effect.runSync",
  "Effect.runSyncExit",
  "Effect.runSyncWith",
  "ManagedRuntime.make",
]);

export const effectRuntimeBoundaryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Effect execution and ManagedRuntime ownership at explicit process/API boundaries.",
    },
    messages: {
      runtimeBoundary:
        "Move '{{call}}' to an approved CLI, script, or SDK compatibility boundary. Application services compose and return Effects; they never execute them.",
      undisposedRuntime:
        "ManagedRuntime '{{name}}' must expose or invoke dispose at this boundary so scopes, connections, and finalizers are closed.",
    },
  },
  create(context) {
    const isOutsideRuntimePolicy =
      !isEffectPolicyPath(context.filename) || isTestOrFixturePath(context.filename);
    if (isOutsideRuntimePolicy) {
      return {};
    }
    const filePath = sourcePathKey(context.filename);
    const runtimes = new Map<string, ESTree.VariableDeclarator>();
    const disposed = new Set<string>();

    return {
      VariableDeclarator(node: ESTree.VariableDeclarator) {
        if (isCallTo(node.init, "ManagedRuntime.make")) {
          const name = identifierName(node.id);
          if (name) {
            runtimes.set(name, node);
          }
        }
      },
      CallExpression(node: ESTree.CallExpression) {
        const path = memberPath(node.callee);
        const isUnapprovedRuntimeCall =
          path !== undefined && runtimeCalls.has(path) && !isApprovedRuntimeBoundary(filePath);
        if (isUnapprovedRuntimeCall) {
          context.report({ node, messageId: "runtimeBoundary", data: { call: path } });
        }
        const isAnonymousManagedRuntime =
          path === "ManagedRuntime.make" &&
          isApprovedRuntimeBoundary(filePath) &&
          node.parent?.type !== "VariableDeclarator";
        if (isAnonymousManagedRuntime) {
          context.report({
            node,
            messageId: "undisposedRuntime",
            data: { name: "anonymousRuntime" },
          });
        }
        const callee = unwrapExpression(node.callee);
        const isUnsupportedMemberCall =
          callee?.type !== "MemberExpression" || callee.computed === true;
        if (isUnsupportedMemberCall) {
          return;
        }
        const objectName = identifierName(callee.object);
        const isRuntimeDisposal =
          objectName !== undefined && identifierName(callee.property) === "dispose";
        if (isRuntimeDisposal) {
          disposed.add(objectName);
        }
      },
      "Program:exit"() {
        if (!isApprovedRuntimeBoundary(filePath)) {
          return;
        }
        for (const [name, node] of runtimes) {
          const isUndisposedRuntime =
            !disposed.has(name) && !hasExposedDisposer(context.sourceCode.text, name);
          if (isUndisposedRuntime) {
            context.report({ node, messageId: "undisposedRuntime", data: { name } });
          }
        }
      },
    };
  },
});

function isApprovedRuntimeBoundary(filePath: string) {
  return (
    filePath === "src/app/cli/entrypoint.ts" ||
    filePath === "src/app/cli/composition-root.ts" ||
    filePath === "src/app/cli/runtime-bootstrap.ts" ||
    filePath === "src/domains/collections/runtime/collection-handle-factory.ts" ||
    filePath === "src/domains/collections/repo/sqlite/sqlite-collection-index.ts" ||
    filePath === "src/domains/tools/runtime/tool-sdk.ts" ||
    filePath === "src/domains/tools/runtime/runtime-support.ts" ||
    /^scripts\/(?:bench|release|smoke)\.ts$/u.test(filePath)
  );
}

function hasExposedDisposer(source: string, runtimeName: string) {
  const escapedName = runtimeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\bdispose\\s*:\\s*${escapedName}\\.dispose\\b`, "u").test(source);
}
