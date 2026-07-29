import {
  asEffectNode,
  callArguments,
  identifierName,
  isCallTo,
  unwrapExpression,
  type EffectAstNode,
} from "./effect-ast.ts";

export function effectSuccessTypeHasCallableMembers(apiType: EffectAstNode | undefined) {
  const effectType =
    apiType?.type === "TSFunctionType"
      ? annotatedType(apiType.returnType ?? apiType.typeAnnotation)
      : apiType;
  const isEffectType =
    effectType?.type === "TSTypeReference" && typeNamePath(effectType.typeName) === "Effect.Effect";
  if (!isEffectType) {
    return false;
  }
  const [successType] = typeArguments(effectType);
  return typeHasCallableMembers(successType);
}

export function lazyEffectExposesCallableContainer(
  value: EffectAstNode,
  localCallables: ReadonlySet<string>,
) {
  const pipeCall = unwrapExpression(value);
  const pipeCallee =
    pipeCall?.type === "CallExpression" ? unwrapExpression(pipeCall.callee) : undefined;
  if (pipeCallee?.type !== "MemberExpression") return false;
  const source = unwrapExpression(pipeCallee.object);
  if (isCallTo(source, "Effect.succeed")) {
    return objectHasCallableMembers(callArguments(source)[0], localCallables);
  }
  const isEffectCallback = isCallTo(source, "Effect.sync") || isCallTo(source, "Effect.gen");
  if (isEffectCallback) {
    return callbackReturnsCallableObject(callArguments(source)[0], localCallables);
  }
  return false;
}

function annotatedType(value: unknown) {
  const node = asEffectNode(value);
  return node?.type === "TSTypeAnnotation" ? asEffectNode(node.typeAnnotation) : node;
}

function typeArguments(value: EffectAstNode) {
  const container = asEffectNode(value.typeArguments ?? value.typeParameters);
  return Array.isArray(container?.params)
    ? container.params.map(asEffectNode).filter((entry) => entry !== undefined)
    : [];
}

function typeNamePath(value: unknown): string | undefined {
  const node = asEffectNode(value);
  const direct = identifierName(node);
  if (direct) return direct;
  if (node?.type !== "TSQualifiedName") return undefined;
  const left = typeNamePath(node.left);
  const right = identifierName(node.right);
  return left && right ? `${left}.${right}` : undefined;
}

function typeHasCallableMembers(value: EffectAstNode | undefined): boolean {
  if (!value) return false;
  if (value.type === "TSParenthesizedType") {
    return typeHasCallableMembers(asEffectNode(value.typeAnnotation));
  }
  const isReadonlyType =
    value.type === "TSTypeReference" && typeNamePath(value.typeName) === "Readonly";
  if (isReadonlyType) {
    return typeHasCallableMembers(typeArguments(value)[0]);
  }
  const hasNoCallableTypeMembers = value.type !== "TSTypeLiteral" || !Array.isArray(value.members);
  if (hasNoCallableTypeMembers) return false;
  const members = value.members as unknown[];
  return members
    .map(asEffectNode)
    .filter((member) => member !== undefined)
    .some((member) => {
      const isCallableSignature =
        member.type === "TSMethodSignature" || member.type === "TSCallSignatureDeclaration";
      if (isCallableSignature) {
        return true;
      }
      return (
        member.type === "TSPropertySignature" &&
        annotatedType(member.typeAnnotation)?.type === "TSFunctionType"
      );
    });
}

function callbackReturnsCallableObject(
  value: EffectAstNode | undefined,
  localCallables: ReadonlySet<string>,
) {
  const isFunctionCallback =
    value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression";
  if (!isFunctionCallback) {
    return false;
  }
  const body = asEffectNode(value.body);
  if (body?.type === "ObjectExpression") return objectHasCallableMembers(body, localCallables);
  const hasNoBlockBody = body?.type !== "BlockStatement" || !Array.isArray(body.body);
  if (hasNoBlockBody) return false;
  const bodyStatements = body.body as unknown[];
  const returned = bodyStatements
    .map(asEffectNode)
    .filter((statement) => statement !== undefined)
    .findLast((statement) => statement.type === "ReturnStatement");
  return objectHasCallableMembers(returned?.argument, localCallables);
}

function objectHasCallableMembers(value: unknown, localCallables: ReadonlySet<string>): boolean {
  const object = unwrapExpression(value);
  const hasNoObjectProperties =
    object?.type !== "ObjectExpression" || !Array.isArray(object.properties);
  if (hasNoObjectProperties) return false;
  const properties = object.properties as unknown[];
  return properties
    .map(asEffectNode)
    .filter((property) => property !== undefined)
    .some((property) => {
      if (property.type !== "Property") return false;
      if (property.method === true) return true;
      const memberValue = unwrapExpression(property.value);
      const isCallableMember =
        memberValue?.type === "ArrowFunctionExpression" ||
        memberValue?.type === "FunctionExpression";
      if (isCallableMember) {
        return true;
      }
      const memberName = identifierName(memberValue);
      return memberName !== undefined && localCallables.has(memberName);
    });
}
