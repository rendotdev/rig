import type { Node } from "@oxlint/plugins";

export type EffectAstNode = Node & {
  readonly [key: string]: unknown;
  readonly parent?: EffectAstNode;
};

export function asEffectNode(value: unknown): EffectAstNode | undefined {
  const isEffectAstNode = value !== null && typeof value === "object" && "type" in value;
  if (!isEffectAstNode) {
    return undefined;
  }
  return value as unknown as EffectAstNode;
}

export function unwrapExpression(value: unknown): EffectAstNode | undefined {
  let node = asEffectNode(value);
  while (
    node &&
    (node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSTypeAssertion" ||
      node.type === "TSInstantiationExpression" ||
      node.type === "ChainExpression")
  ) {
    node = asEffectNode(node.expression);
  }
  return node;
}

export function identifierName(value: unknown): string | undefined {
  const node = asEffectNode(value);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

export function propertyName(value: unknown): string | undefined {
  const node = asEffectNode(value);
  const isNamedIdentifier = node?.type === "Identifier" && typeof node.name === "string";
  if (isNamedIdentifier) {
    return node.name as string;
  }
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

export function memberPath(value: unknown): string | undefined {
  const node = unwrapExpression(value);
  if (!node) {
    return undefined;
  }
  const name = identifierName(node);
  if (name) {
    return name;
  }
  const isUnsupportedMemberExpression = node.type !== "MemberExpression" || node.computed === true;
  if (isUnsupportedMemberExpression) {
    return undefined;
  }
  const objectPath = memberPath(node.object);
  const memberName = propertyName(node.property);
  return objectPath && memberName ? `${objectPath}.${memberName}` : undefined;
}

export function isCallTo(value: unknown, path: string): boolean {
  const node = unwrapExpression(value);
  return node?.type === "CallExpression" && memberPath(node.callee) === path;
}

export function callArguments(value: unknown): readonly EffectAstNode[] {
  const node = unwrapExpression(value);
  const hasNoCallArguments = node?.type !== "CallExpression" || !Array.isArray(node.arguments);
  if (hasNoCallArguments) {
    return [];
  }
  const argumentsArray = node.arguments as unknown[];
  return argumentsArray.map(asEffectNode).filter((argument) => argument !== undefined);
}

export function callTypeArguments(value: unknown): readonly EffectAstNode[] {
  const node = unwrapExpression(value);
  if (node?.type !== "CallExpression") {
    return [];
  }
  const typeArguments = asEffectNode(node.typeArguments ?? node.typeParameters);
  const hasNoTypeArguments = !typeArguments || !Array.isArray(typeArguments.params);
  if (hasNoTypeArguments) {
    return [];
  }
  const params = typeArguments.params as unknown[];
  return params.map(asEffectNode).filter((argument) => argument !== undefined);
}

export function isTopLevelDeclaration(value: unknown): boolean {
  const node = asEffectNode(value);
  if (!node?.parent) {
    return true;
  }
  if (node.parent.type === "Program") {
    return true;
  }
  return (
    (node.parent.type === "ExportNamedDeclaration" ||
      node.parent.type === "ExportDefaultDeclaration") &&
    node.parent.parent?.type === "Program"
  );
}

export function sourcePathKey(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  for (const marker of ["/src/", "/scripts/", "/test/"] as const) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) {
      return normalized.slice(index + 1);
    }
  }
  return normalized.replace(/^\.\//u, "");
}

export function isTestOrFixturePath(filePath: string): boolean {
  const path = sourcePathKey(filePath);
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
    path.startsWith("test/") ||
    path.includes("/fixtures/") ||
    path.endsWith(".d.ts")
  );
}

export function isEffectPolicyPath(filePath: string): boolean {
  const path = sourcePathKey(filePath);
  const isProductionSource = path.startsWith("src/") || path.startsWith("scripts/");
  return isProductionSource && !path.startsWith("src/tooling/") && !isTestOrFixturePath(path);
}
