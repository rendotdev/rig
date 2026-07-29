import { Schema } from "effect";

const RoutedName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

export class ToolName extends Schema.Class<ToolName>("ToolName")({
  value: RoutedName,
}) {}

export class CommandName extends Schema.Class<CommandName>("CommandName")({
  value: RoutedName,
}) {}

export class CollectionName extends Schema.Class<CollectionName>("CollectionName")({
  value: RoutedName,
}) {}

export class CommandTarget extends Schema.Class<CommandTarget>("CommandTarget")({
  tool: RoutedName,
  command: RoutedName,
  id: Schema.String,
}) {}
