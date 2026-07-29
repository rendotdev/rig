import type { CollectionDefinition, CollectionIndexInterface } from "./tool-collection";

export type CollectionOperationContext = Readonly<{
  path: string;
  definition: CollectionDefinition;
  index: CollectionIndexInterface;
}>;

export type CollectionData = Record<string, unknown>;
