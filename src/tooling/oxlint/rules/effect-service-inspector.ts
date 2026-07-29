import type { Context, ESTree } from "@oxlint/plugins";
import {
  asEffectNode,
  callArguments,
  callTypeArguments,
  identifierName,
  isCallTo,
  memberPath,
  propertyName,
  unwrapExpression,
  type EffectAstNode,
} from "./effect-ast.ts";
import {
  effectSuccessTypeHasCallableMembers,
  lazyEffectExposesCallableContainer,
} from "./effect-service-callable-contract.ts";
import { returnedAsConstNames } from "./effect-service-return-inspector.ts";
import { inspectEffectFn, inspectSpannedEffect } from "./effect-service-trace-inspector.ts";

type ServiceDescriptor = Readonly<{
  className: string;
  outerCall: EffectAstNode;
  serviceFactory: EffectAstNode;
}>;

type ServiceOperation = Readonly<{
  name: string;
  kind: "data" | "function" | "lazy";
  callablePayload: boolean;
}>;

export function inspectContextService(node: ESTree.Class): ServiceDescriptor | undefined {
  const className = node.id?.name;
  const outerCall = unwrapExpression(node.superClass);
  const hasNoServiceCall = !className || outerCall?.type !== "CallExpression";
  if (hasNoServiceCall) {
    return undefined;
  }
  const serviceFactory = unwrapExpression(outerCall.callee);
  const isNotContextService =
    serviceFactory?.type !== "CallExpression" ||
    memberPath(serviceFactory.callee) !== "Context.Service";
  if (isNotContextService) {
    return undefined;
  }
  return { className, outerCall, serviceFactory };
}

export function validateEffectService(
  context: Context,
  node: ESTree.Class,
  service: ServiceDescriptor,
) {
  if (!service.className.endsWith("Service")) {
    context.report({
      node: node.id ?? node,
      messageId: "serviceSuffix",
      data: { name: service.className },
    });
  }
  const declaredApi = validateInlineApi(context, service);
  const make = findMake(context, service);
  if (!make) {
    context.report({ node: service.outerCall, messageId: "inlineMake" });
  } else if (make.kind === "generator") {
    validateMake(context, service.className, make.callback, declaredApi);
  }
  validateStaticLayer(context, node, service.className);
}

function validateInlineApi(context: Context, service: ServiceDescriptor) {
  const typeArguments = callTypeArguments(service.serviceFactory);
  const selfType = typeArguments[0];
  const apiType = typeArguments[1];
  const selfName =
    selfType?.type === "TSTypeReference"
      ? identifierName(asEffectNode(selfType.typeName))
      : undefined;
  const hasInvalidInlineApi = selfName !== service.className || apiType?.type !== "TSTypeLiteral";
  if (hasInvalidInlineApi) {
    context.report({ node: service.serviceFactory, messageId: "inlineApi" });
    return [];
  }

  const members = Array.isArray(apiType.members)
    ? apiType.members.map(asEffectNode).filter((member) => member !== undefined)
    : [];
  return members.map((member) => inspectApiMember(context, service.className, member));
}

function inspectApiMember(context: Context, serviceName: string, member: EffectAstNode) {
  const name = propertyName(member.key) ?? "unknownMethod";
  const typeAnnotation = asEffectNode(member.typeAnnotation);
  const functionType = asEffectNode(typeAnnotation?.typeAnnotation);
  const source = sourceFor(context, member);
  const isEffectType = /\bEffect\.Effect\s*</u.test(source);
  const isReadonly = member.type === "TSPropertySignature" && member.readonly === true;
  const isEffectMethod = functionType?.type === "TSFunctionType" && isEffectType;
  const isConfigData =
    serviceName.endsWith("ConfigService") &&
    isReadonly &&
    functionType?.type !== "TSFunctionType" &&
    !isEffectType;
  const parameterCount = functionParameterCount(functionType);
  const callablePayload = effectSuccessTypeHasCallableMembers(functionType);
  const hasInvalidReadonlyEffect = (!isReadonly || !isEffectType) && !isConfigData;
  if (hasInvalidReadonlyEffect) {
    context.report({ node: member, messageId: "readonlyApi", data: { name } });
  }
  const shouldBeLazyEffect = isEffectMethod && parameterCount === 0;
  if (shouldBeLazyEffect) {
    context.report({
      node: member,
      messageId: "lazyEffectApi",
      data: { name, service: serviceName },
    });
  }
  if (callablePayload) {
    context.report({ node: member, messageId: "callableEffectPayload", data: { name } });
  }
  const kind = isConfigData ? "data" : isEffectMethod ? "function" : "lazy";
  return { name, kind, callablePayload } as const;
}

function functionParameterCount(functionType: EffectAstNode | undefined) {
  if (functionType?.type !== "TSFunctionType") {
    return 0;
  }
  if (Array.isArray(functionType.params)) {
    return functionType.params.length;
  }
  return Array.isArray(functionType.parameters) ? functionType.parameters.length : 0;
}

function findMake(context: Context, service: ServiceDescriptor) {
  const [tag, options] = callArguments(service.outerCall);
  const tagValue = tag?.type === "Literal" && typeof tag.value === "string" ? tag.value : undefined;
  if (!tagValue?.includes(service.className)) {
    context.report({
      node: tag ?? service.outerCall,
      messageId: "serviceTag",
      data: { service: service.className },
    });
  }
  const hasNoServiceOptions =
    options?.type !== "ObjectExpression" || !Array.isArray(options.properties);
  if (hasNoServiceOptions) {
    return undefined;
  }
  const optionProperties = options.properties as unknown[];
  const makeProperty = optionProperties
    .map(asEffectNode)
    .find((property) => property?.type === "Property" && propertyName(property.key) === "make");
  const makeCall = unwrapExpression(makeProperty?.value);
  if (isCallTo(makeCall, "Effect.gen")) {
    const [callback] = callArguments(makeCall);
    return callback?.type === "FunctionExpression" && callback.generator === true
      ? ({ kind: "generator", callback } as const)
      : undefined;
  }
  const isConfigValue =
    service.className.endsWith("ConfigService") &&
    (isCallTo(makeCall, "Effect.succeed") || isCallTo(makeCall, "Effect.sync"));
  return isConfigValue ? ({ kind: "config" } as const) : undefined;
}

function validateMake(
  context: Context,
  serviceName: string,
  callback: EffectAstNode,
  declaredApi: readonly ServiceOperation[],
) {
  const body = asEffectNode(callback.body);
  const statements = Array.isArray(body?.body)
    ? body.body.map(asEffectNode).filter((statement) => statement !== undefined)
    : [];
  const implementations = collectImplementations(context, serviceName, statements);
  validateReturnedApi(context, callback, body, statements, declaredApi, implementations);
}

function collectImplementations(
  context: Context,
  serviceName: string,
  statements: readonly EffectAstNode[],
) {
  const effectFns = new Set<string>();
  const lazyEffects = new Set<string>();
  const callableContainers = new Set<string>();
  const localCallables = new Set<string>();
  for (const statement of statements) {
    const hasNoVariableDeclarations =
      statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations);
    if (hasNoVariableDeclarations) {
      continue;
    }
    const declarations = statement.declarations as unknown[];
    for (const declaration of declarations
      .map(asEffectNode)
      .filter((entry) => entry !== undefined)) {
      const name = identifierName(declaration.id);
      const init = unwrapExpression(declaration.init);
      const isLocalCallable =
        name !== undefined &&
        (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression");
      if (isLocalCallable) {
        localCallables.add(name);
      }
    }
  }
  for (const statement of statements) {
    const hasNoVariableDeclarations =
      statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations);
    if (hasNoVariableDeclarations) {
      continue;
    }
    const declarations = statement.declarations as unknown[];
    for (const declaration of declarations
      .map(asEffectNode)
      .filter((entry) => entry !== undefined)) {
      const name = identifierName(declaration.id);
      const init = unwrapExpression(declaration.init);
      const isCallableBinding =
        init?.type === "ArrowFunctionExpression" ||
        init?.type === "FunctionExpression" ||
        isCallTo(init, "Effect.gen") ||
        inspectEffectFn(init) !== undefined ||
        inspectSpannedEffect(init) !== undefined;
      const hasMutableCallableBinding =
        name !== undefined && statement.kind !== "const" && isCallableBinding;
      if (hasMutableCallableBinding) {
        context.report({ node: declaration, messageId: "localConst", data: { name } });
      }
      inspectImplementation(
        context,
        serviceName,
        declaration,
        effectFns,
        lazyEffects,
        callableContainers,
        localCallables,
      );
    }
  }
  return { effectFns, lazyEffects, callableContainers } as const;
}

function inspectImplementation(
  context: Context,
  serviceName: string,
  declaration: EffectAstNode,
  effectFns: Set<string>,
  lazyEffects: Set<string>,
  callableContainers: Set<string>,
  localCallables: ReadonlySet<string>,
) {
  const name = identifierName(declaration.id);
  const init = unwrapExpression(declaration.init);
  const hasNoNamedImplementation = !name || !init;
  if (hasNoNamedImplementation) {
    return;
  }
  if (init.type === "FunctionExpression") {
    context.report({ node: declaration, messageId: "pureHelper", data: { name } });
    return;
  }
  if (isCallTo(init, "Effect.gen")) {
    context.report({
      node: declaration,
      messageId: "effectHelper",
      data: { name, service: serviceName },
    });
    return;
  }
  const lazyEffect = inspectSpannedEffect(init);
  if (lazyEffect) {
    lazyEffects.add(name);
    if (lazyEffectExposesCallableContainer(init, localCallables)) {
      callableContainers.add(name);
    }
    validateTraceName(context, lazyEffect, serviceName, name);
    return;
  }
  const effectFn = inspectEffectFn(init);
  if (!effectFn) {
    return;
  }
  effectFns.add(name);
  validateTraceName(context, effectFn, serviceName, name);
  if (!effectFn.generator) {
    context.report({
      node: declaration,
      messageId: "effectFnGenerator",
      data: { name, service: serviceName },
    });
  }
}

function validateTraceName(
  context: Context,
  trace: Readonly<{ label?: string; labelNode: EffectAstNode }>,
  serviceName: string,
  operationName: string,
) {
  const expected = `${serviceName}.${operationName}`;
  if (trace.label !== expected) {
    context.report({ node: trace.labelNode, messageId: "effectFnName", data: { expected } });
  }
}

function validateReturnedApi(
  context: Context,
  callback: EffectAstNode,
  body: EffectAstNode | undefined,
  statements: readonly EffectAstNode[],
  declaredApi: readonly ServiceOperation[],
  implementations: Readonly<{
    effectFns: Set<string>;
    lazyEffects: Set<string>;
    callableContainers: Set<string>;
  }>,
) {
  const returnStatement = statements.findLast((statement) => statement.type === "ReturnStatement");
  const returned = returnedAsConstNames(returnStatement);
  if (!returned) {
    context.report({ node: returnStatement ?? body ?? callback, messageId: "returnedApi" });
    return;
  }
  for (const operation of declaredApi) {
    if (operation.kind === "data") {
      continue;
    }
    const implementationSet =
      operation.kind === "function" ? implementations.effectFns : implementations.lazyEffects;
    const hasInvalidPublicMethod =
      !implementationSet.has(operation.name) && returned.includes(operation.name);
    if (hasInvalidPublicMethod) {
      context.report({
        node: returnStatement ?? callback,
        messageId: "publicMethod",
        data: { name: operation.name },
      });
    }
    const exposesCallableLazyValue =
      operation.kind === "lazy" &&
      !operation.callablePayload &&
      implementations.callableContainers.has(operation.name) &&
      returned.includes(operation.name);
    if (exposesCallableLazyValue) {
      context.report({
        node: returnStatement ?? callback,
        messageId: "callableEffectValue",
        data: { name: operation.name },
      });
    }
  }
  reportApiMismatch(context, returnStatement ?? callback, declaredApi, returned);
}

function reportApiMismatch(
  context: Context,
  node: EffectAstNode,
  declaredApi: readonly ServiceOperation[],
  returned: readonly string[],
) {
  const declared = declaredApi.map(({ name }) => name).toSorted();
  const actual = [...returned].toSorted();
  if (declared.join("\0") !== actual.join("\0")) {
    context.report({
      node,
      messageId: "apiMismatch",
      data: {
        declared: declared.join(", ") || "none",
        returned: actual.join(", ") || "none",
      },
    });
  }
}

function validateStaticLayer(context: Context, node: ESTree.Class, serviceName: string) {
  const members = node.body.body.map(asEffectNode).filter((member) => member !== undefined);
  const layer = members.find((member) => propertyName(member.key) === "layer");
  const value = unwrapExpression(layer?.value);
  const [serviceArgument, makeArgument] = callArguments(value);
  const hasExactLayer =
    layer?.type === "PropertyDefinition" &&
    layer.static === true &&
    layer.readonly === true &&
    (isCallTo(value, "Layer.effect") || isCallTo(value, "Layer.scoped")) &&
    identifierName(serviceArgument) === serviceName &&
    memberPath(makeArgument) === `${serviceName}.make`;
  if (!hasExactLayer) {
    context.report({
      node: layer ?? node.body,
      messageId: "staticLayer",
      data: { service: serviceName },
    });
  }
  if (members.some((member) => member !== layer)) {
    context.report({ node: node.body, messageId: "classMembers" });
  }
}

function sourceFor(context: Context, node: EffectAstNode) {
  const range = node.range;
  return Array.isArray(range)
    ? context.sourceCode.text.slice(range[0] as number, range[1] as number)
    : "";
}
