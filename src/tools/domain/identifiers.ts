import { RigErrorClass } from "../../errors/RigError";

const RoutedNamePattern = /^[A-Za-z0-9_-]+$/;

export class ToolNameClass {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== "string" || !RoutedNamePattern.test(value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid tool name: ${value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    this.value = value;
  }

  parse(value: string): ToolNameClass {
    return new ToolNameClass(value);
  }
}

export class CommandNameClass {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== "string" || !RoutedNamePattern.test(value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid command name: ${value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    this.value = value;
  }

  parse(value: string): CommandNameClass {
    return new CommandNameClass(value);
  }
}

export class CollectionNameClass {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== "string" || !RoutedNamePattern.test(value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid collection name: ${value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    this.value = value;
  }

  parse(value: string): CollectionNameClass {
    return new CollectionNameClass(value);
  }
}

export class CommandTargetClass {
  readonly id: string;

  constructor(
    readonly tool: string,
    readonly command: string,
  ) {
    this.id = `${tool}.${command}`;
  }

  from(tool: string, command: string): CommandTargetClass {
    return new CommandTargetClass(
      new ToolNameClass(tool).value,
      new CommandNameClass(command).value,
    );
  }

  parse(id: string): CommandTargetClass {
    if (typeof id !== "string") throw this.invalid(id);
    const match = id.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) throw this.invalid(id);
    return new CommandTargetClass(match[1]!, match[2]!);
  }

  private invalid(id: unknown): RigErrorClass {
    return new RigErrorClass("INPUT_ERROR", `Command id must use <tool>.<command>: ${String(id)}`);
  }
}

export const toolNames = new ToolNameClass("tool");
export const commandNames = new CommandNameClass("command");
export const collectionNames = new CollectionNameClass("collection");
export const commandTargets = new CommandTargetClass("tool", "command");
