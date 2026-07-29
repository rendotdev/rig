import {
  callArguments,
  isCallTo,
  propertyName,
  unwrapExpression,
  type EffectAstNode,
} from "./effect-ast.ts";

export function inspectEffectFn(value: unknown) {
  const outerCall = unwrapExpression(value);
  if (outerCall?.type !== "CallExpression") return undefined;
  const factoryCall = unwrapExpression(outerCall.callee);
  if (!isCallTo(factoryCall, "Effect.fn")) return undefined;
  const [labelNode] = callArguments(factoryCall);
  const label =
    labelNode?.type === "Literal" && typeof labelNode.value === "string"
      ? labelNode.value
      : undefined;
  const [implementation] = callArguments(outerCall);
  return {
    label,
    labelNode: labelNode ?? factoryCall ?? outerCall,
    generator: implementation?.type === "FunctionExpression" && implementation.generator === true,
  } as const;
}

export function inspectSpannedEffect(value: unknown) {
  const pipeCall = unwrapExpression(value);
  const callee =
    pipeCall?.type === "CallExpression" ? unwrapExpression(pipeCall.callee) : undefined;
  const isPipe =
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    propertyName(callee.property) === "pipe";
  if (!isPipe) return undefined;
  const span = callArguments(pipeCall).find((argument) => isCallTo(argument, "Effect.withSpan"));
  if (!span) return undefined;
  const [labelNode] = callArguments(span);
  const label =
    labelNode?.type === "Literal" && typeof labelNode.value === "string"
      ? labelNode.value
      : undefined;
  return { label, labelNode: (labelNode ?? span) as EffectAstNode } as const;
}
