import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";
import {
  identifierName,
  isEffectPolicyPath,
  isTopLevelDeclaration,
  memberPath,
  unwrapExpression,
} from "./effect-ast.ts";
import { inspectContextService, validateEffectService } from "./effect-service-inspector.ts";

export const effectServiceContractRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce Rig's canonical Effect v4 Context.Service declaration and method shape.",
    },
    messages: {
      serviceSuffix:
        "Name this behavioral service '{{name}}Service' so its architectural role is explicit.",
      inlineApi:
        "Inline the service API as Context.Service<ServiceName, { readonly method: (...) => Effect.Effect<...> }>; detached Shape aliases are forbidden.",
      readonlyApi:
        "Declare '{{name}}' as readonly. Operations with inputs are function properties returning Effect.Effect; zero-argument operations are lazy Effect.Effect values.",
      lazyEffectApi:
        "Declare zero-argument operation '{{name}}' as readonly {{name}}: Effect.Effect<...>, then trace its value with .pipe(Effect.withSpan(\"{{service}}.{{name}}\")).",
      inlineMake:
        "Declare make inline in Context.Service options. Behavioral services use Effect.gen(function* () { ... }); ConfigService may use Effect.gen, Effect.succeed, or Effect.sync.",
      pureHelper:
        "Declare private pure helper '{{name}}' as a local const arrow inside the service make block.",
      localConst:
        "Declare private helper '{{name}}' with const. Service helpers and operations are immutable local bindings inside make.",
      effectHelper:
        "Wrap effectful helper '{{name}}' with Effect.fn(\"{{service}}.{{name}}\")(function* (...) { ... }).",
      effectFnName:
        "Name this effect '{{expected}}' so traces identify the owning service and method.",
      effectFnGenerator:
        "Implement '{{name}}' with the generator callback form Effect.fn(\"{{service}}.{{name}}\")(function* (...) { ... }).",
      publicMethod:
        "Public service operation '{{name}}' must resolve to a local named Effect.fn, or a lazy Effect value traced with Effect.withSpan for a zero-argument operation.",
      callableEffectPayload:
        "Service operation '{{name}}' exposes an object with callable members through Effect. Promote the owned behavior to named service methods instead.",
      callableEffectValue:
        "Lazy service operation '{{name}}' returns a locally-owned callable container. Expose each behavior as a named Effect service method instead.",
      effectSpan:
        "Trace lazy Effect '{{name}}' with .pipe(Effect.withSpan(\"{{service}}.{{name}}\")).",
      returnedApi:
        "Finish the service make block with return { publicMethod } as const; return only the declared public Effect.fn methods.",
      apiMismatch:
        "Keep the inline API and returned object identical. Declared: {{declared}}. Returned: {{returned}}.",
      staticLayer:
        "Add static readonly layer = Layer.effect({{service}}, {{service}}.make), or Layer.scoped when make owns scoped resources.",
      classMembers:
        "A Context.Service declaration may contain only static readonly layer; keep all behavior inside its make block.",
      deepEffectImport:
        "Import Context, Effect, Layer, ManagedRuntime, and other Effect modules as named imports from 'effect'; deep Effect imports are forbidden.",
      namedEffectImport:
        "Use named imports from 'effect', for example import { Context, Effect, Layer } from 'effect'.",
      serviceTag:
        "Use a stable service tag string containing the service name, for example '@rendotdev/rig/domain/{{service}}'.",
      layerSuffix:
        "Name this composed layer '{{name}}Layer'. Layer bindings use a descriptive camelCase name with the Layer suffix; each service's owned layer remains static `layer`.",
      taggedErrorSuffix:
        "Name tagged operational failure '{{name}}Error'. The Error suffix makes the typed failure channel legible to agents and catchTag handlers.",
    },
  },
  create(context) {
    if (!isEffectPolicyPath(context.filename)) {
      return {};
    }
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const source = node.source.value;
        if (source.startsWith("effect/")) {
          context.report({ node: node.source, messageId: "deepEffectImport" });
          return;
        }
        if (source !== "effect") {
          return;
        }
        const hasNonNamedImport = node.specifiers.some(
          (specifier) => specifier.type !== "ImportSpecifier",
        );
        if (hasNonNamedImport) {
          context.report({ node, messageId: "namedEffectImport" });
        }
      },
      ClassDeclaration(node: ESTree.Class) {
        const service = inspectContextService(node);
        if (service) {
          validateEffectService(context, node, service);
          return;
        }
        const name = node.id?.name;
        const hasInvalidTaggedErrorName =
          name !== undefined && isTaggedErrorClass(node) && !name.endsWith("Error");
        if (hasInvalidTaggedErrorName) {
          context.report({ node: node.id ?? node, messageId: "taggedErrorSuffix", data: { name } });
        }
      },
      VariableDeclarator(node: ESTree.VariableDeclarator) {
        const isNotTopLevelLayer = !isTopLevelDeclaration(node) || !isLayerBinding(node.init);
        if (isNotTopLevelLayer) {
          return;
        }
        const name = identifierName(node.id);
        const hasInvalidLayerName = name !== undefined && !name.endsWith("Layer");
        if (hasInvalidLayerName) {
          context.report({ node: node.id, messageId: "layerSuffix", data: { name } });
        }
      },
    };
  },
});

function isLayerBinding(value: unknown) {
  const expression = unwrapExpression(value);
  if (!expression) {
    return false;
  }
  const directPath = memberPath(expression);
  if (directPath?.endsWith(".layer")) {
    return true;
  }
  if (expression.type !== "CallExpression") {
    return false;
  }
  const calleePath = memberPath(expression.callee);
  return calleePath?.startsWith("Layer.") === true;
}

function isTaggedErrorClass(node: ESTree.Class) {
  let expression = unwrapExpression(node.superClass);
  for (let depth = 0; expression && depth < 4; depth++) {
    if (expression.type !== "CallExpression") {
      return false;
    }
    if (memberPath(expression.callee) === "Schema.TaggedErrorClass") {
      return true;
    }
    expression = unwrapExpression(expression.callee);
  }
  return false;
}
