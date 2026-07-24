import { defineSingleton } from "../../define";
import { RigErrorClass } from "../../errors/RigError";

const RoutedNamePattern = /^[A-Za-z0-9_-]+$/;

export const ToolNameSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { value: string }) {
    if (typeof params.value !== "string" || !RoutedNamePattern.test(params.value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid tool name: ${params.value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    return { value: params.value };
  },
  parse(params: { value: string }) {
    return ToolNameSingleton.create(params);
  },
});

export const CommandNameSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { value: string }) {
    if (typeof params.value !== "string" || !RoutedNamePattern.test(params.value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid command name: ${params.value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    return { value: params.value };
  },
  parse(params: { value: string }) {
    return CommandNameSingleton.create(params);
  },
});

export const CollectionNameSingleton = defineSingleton({
  params: {},
  deps: {},
  create(params: { value: string }) {
    if (typeof params.value !== "string" || !RoutedNamePattern.test(params.value)) {
      throw new RigErrorClass("TOOL_INVALID", `Invalid collection name: ${params.value}`, {
        expected: "letters, numbers, hyphens, or underscores",
      });
    }
    return { value: params.value };
  },
  parse(params: { value: string }) {
    return CollectionNameSingleton.create(params);
  },
});

export const CommandTargetSingleton = defineSingleton({
  params: { idSeparator: ".", expectedIdFormat: "<tool>.<command>" },
  deps: { ToolNameSingleton, CommandNameSingleton },
  create(params: { tool: string; command: string }) {
    return {
      tool: params.tool,
      command: params.command,
      id: `${params.tool}${this.params.idSeparator}${params.command}`,
    };
  },
  from(params: { tool: string; command: string }) {
    return CommandTargetSingleton.create({
      tool: this.deps.ToolNameSingleton.create({ value: params.tool }).value,
      command: this.deps.CommandNameSingleton.create({ value: params.command }).value,
    });
  },
  invalid(params: { id: unknown }) {
    return new RigErrorClass(
      "INPUT_ERROR",
      `Command id must use ${this.params.expectedIdFormat}: ${String(params.id)}`,
    );
  },
  parse(params: { id: string }) {
    if (typeof params.id !== "string") throw CommandTargetSingleton.invalid({ id: params.id });
    const match = params.id.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) throw CommandTargetSingleton.invalid({ id: params.id });
    return CommandTargetSingleton.create({ tool: match[1]!, command: match[2]! });
  },
});

export type ToolNameClass = {
  readonly value: string;
  parse(value: string): ToolNameClass;
};

type ToolNameConstructor = {
  new (value: string): ToolNameClass;
  readonly prototype: ToolNameClass;
};

export const ToolNameClass = function (this: ToolNameClass, value: string) {
  Object.assign(this, ToolNameSingleton.create({ value }));
} as unknown as ToolNameConstructor;

Object.defineProperty(ToolNameClass.prototype, "parse", {
  configurable: true,
  value: function parse(value: string) {
    return new ToolNameClass(value);
  },
  writable: true,
});

export type CommandNameClass = {
  readonly value: string;
  parse(value: string): CommandNameClass;
};

type CommandNameConstructor = {
  new (value: string): CommandNameClass;
  readonly prototype: CommandNameClass;
};

export const CommandNameClass = function (this: CommandNameClass, value: string) {
  Object.assign(this, CommandNameSingleton.create({ value }));
} as unknown as CommandNameConstructor;

Object.defineProperty(CommandNameClass.prototype, "parse", {
  configurable: true,
  value: function parse(value: string) {
    return new CommandNameClass(value);
  },
  writable: true,
});

export type CollectionNameClass = {
  readonly value: string;
  parse(value: string): CollectionNameClass;
};

type CollectionNameConstructor = {
  new (value: string): CollectionNameClass;
  readonly prototype: CollectionNameClass;
};

export const CollectionNameClass = function (this: CollectionNameClass, value: string) {
  Object.assign(this, CollectionNameSingleton.create({ value }));
} as unknown as CollectionNameConstructor;

Object.defineProperty(CollectionNameClass.prototype, "parse", {
  configurable: true,
  value: function parse(value: string) {
    return new CollectionNameClass(value);
  },
  writable: true,
});

export type CommandTargetClass = {
  readonly tool: string;
  readonly command: string;
  readonly id: string;
  from(tool: string, command: string): CommandTargetClass;
  parse(id: string): CommandTargetClass;
};

type CommandTargetConstructor = {
  new (tool: string, command: string): CommandTargetClass;
  readonly prototype: CommandTargetClass;
};

export const CommandTargetClass = function (
  this: CommandTargetClass,
  tool: string,
  command: string,
) {
  Object.assign(this, CommandTargetSingleton.create({ tool, command }));
} as unknown as CommandTargetConstructor;

Object.defineProperties(CommandTargetClass.prototype, {
  from: {
    configurable: true,
    value: function from(tool: string, command: string) {
      const target = CommandTargetSingleton.from({ tool, command });
      return new CommandTargetClass(target.tool, target.command);
    },
    writable: true,
  },
  parse: {
    configurable: true,
    value: function parse(id: string) {
      const target = CommandTargetSingleton.parse({ id });
      return new CommandTargetClass(target.tool, target.command);
    },
    writable: true,
  },
});

export const toolNames = new ToolNameClass("tool");
export const commandNames = new CommandNameClass("command");
export const collectionNames = new CollectionNameClass("collection");
export const commandTargets = new CommandTargetClass("tool", "command");
