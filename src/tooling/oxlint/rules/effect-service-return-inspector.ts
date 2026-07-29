import {
  asEffectNode,
  identifierName,
  propertyName,
  unwrapExpression,
  type EffectAstNode,
} from "./effect-ast.ts";

export function returnedAsConstNames(returnStatement: EffectAstNode | undefined) {
  const argument = asEffectNode(returnStatement?.argument);
  const assertion =
    argument?.type === "TSAsExpression" ? asEffectNode(argument.typeAnnotation) : undefined;
  const isConstAssertion =
    (assertion?.type === "TSTypeReference" && identifierName(assertion.typeName) === "const") ||
    assertion?.type === "TSConstKeyword";
  const object =
    argument?.type === "TSAsExpression" ? unwrapExpression(argument.expression) : undefined;
  const hasInvalidReturnedObject =
    !isConstAssertion || object?.type !== "ObjectExpression" || !Array.isArray(object.properties);
  if (hasInvalidReturnedObject) {
    return undefined;
  }
  const properties = object.properties as unknown[];
  const names: string[] = [];
  for (const property of properties.map(asEffectNode).filter((entry) => entry !== undefined)) {
    const name = property.type === "Property" ? propertyName(property.key) : undefined;
    const hasInvalidReturnedProperty = !name || identifierName(property.value) !== name;
    if (hasInvalidReturnedProperty) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}
