import { Context, Effect, Layer, Predicate } from "effect";

class CollectionYamlScalarService extends Context.Service<
  CollectionYamlScalarService,
  { readonly parse: (value: string) => Effect.Effect<unknown> }
>()("@rendotdev/rig/collections/CollectionYamlScalarService", {
  make: Effect.gen(function* () {
    const parse = Effect.fn("CollectionYamlScalarService.parse")(function* (value: string) {
      if (value === "true") return true;
      if (value === "false") return false;
      const isNullScalar = value === "null" || value === "~" || value === "";
      if (isNullScalar) return null;
      const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
      const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
      const isQuotedScalar = isDoubleQuoted || isSingleQuoted;
      if (isQuotedScalar) return value.slice(1, -1);
      const number = Number(value);
      return !Number.isNaN(number) && value !== "" ? number : value;
    });
    return { parse } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionYamlScalarService,
    CollectionYamlScalarService.make,
  );
}

class CollectionYamlParserService extends Context.Service<
  CollectionYamlParserService,
  {
    readonly parse: (yaml: string) => Effect.Effect<Record<string, unknown>>;
  }
>()("@rendotdev/rig/collections/CollectionYamlParserService", {
  make: Effect.gen(function* () {
    const scalar = yield* CollectionYamlScalarService;
    const parse = Effect.fn("CollectionYamlParserService.parse")(function* (yaml: string) {
      const result: Record<string, unknown> = {};
      let currentKey: string | null = null;
      let block: unknown[] | Record<string, unknown> | null = null;
      let arrayObject: Record<string, unknown> | null = null;
      for (const line of yaml.split(/\r?\n/)) {
        const isArrayBlockEntry = block !== null && /^\s+-\s/.test(line);
        if (isArrayBlockEntry) {
          if (!Array.isArray(block)) block = [];
          if (arrayObject !== null) block.push(arrayObject);
          const value = line.replace(/^\s+-\s*/, "");
          const entry = value.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          arrayObject = entry ? { [entry[1]!]: yield* scalar.parse(entry[2]!.trim()) } : null;
          if (!entry) block.push(yield* scalar.parse(value));
          continue;
        }
        const isArrayObjectContinuation = arrayObject !== null && /^\s{4,}\S/.test(line);
        if (isArrayObjectContinuation) {
          const entry = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          if (entry) {
            arrayObject![entry[1]!] = yield* scalar.parse(entry[2]!.trim());
            continue;
          }
        }
        const isObjectBlockEntry =
          block !== null && /^\s{2}[A-Za-z_]/.test(line) && !/^\s+-/.test(line);
        if (isObjectBlockEntry) {
          const isEmptyArrayBlock = Array.isArray(block) && block.length === 0;
          if (isEmptyArrayBlock) block = {};
          const entry = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          const canAssignObjectEntry = !Array.isArray(block) && entry !== null;
          if (canAssignObjectEntry) {
            (block as Record<string, unknown>)[entry![1]!] = yield* scalar.parse(entry![2]!.trim());
            continue;
          }
        }
        if (arrayObject !== null) {
          if (Array.isArray(block)) block.push(arrayObject);
          arrayObject = null;
        }
        const startsNextTopLevelEntry =
          block !== null && currentKey !== null && /^[A-Za-z_]/.test(line);
        if (startsNextTopLevelEntry) {
          result[currentKey!] = block;
          block = null;
        }
        const isBlankOrComment = !line.trim() || line.trim().startsWith("#");
        if (isBlankOrComment) continue;
        const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!entry) continue;
        currentKey = entry[1]!;
        const value = entry[2]!.trim();
        if (value === "[]") result[currentKey] = [];
        else if (value === "") block = [];
        else {
          const isInlineArray = value.startsWith("[") && value.endsWith("]");
          if (isInlineArray) {
            result[currentKey] = yield* Effect.forEach(value.slice(1, -1).split(","), (item) =>
              scalar.parse(item.trim()),
            );
          } else result[currentKey] = yield* scalar.parse(value);
        }
      }
      const hasPendingArrayObject = arrayObject !== null && Array.isArray(block);
      if (hasPendingArrayObject) (block as unknown[]).push(arrayObject);
      const hasPendingBlock = block !== null && currentKey !== null;
      if (hasPendingBlock) result[currentKey!] = block;
      return result;
    });
    return { parse } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionYamlParserService,
    CollectionYamlParserService.make,
  );
}

class CollectionYamlSerializerService extends Context.Service<
  CollectionYamlSerializerService,
  {
    readonly serialize: (data: Record<string, unknown>, indent?: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/collections/CollectionYamlSerializerService", {
  make: Effect.gen(function* () {
    const serializeScalar = (value: unknown) => {
      const isNullish = value === null || value === undefined;
      if (isNullish) return "null";
      const isPrimitiveNumberOrBoolean = typeof value === "boolean" || typeof value === "number";
      if (isPrimitiveNumberOrBoolean) return String(value);
      const string = String(value);
      return /[:{},&*#?|><!%@`\n[\]]/.test(string) || string.includes(": ")
        ? `"${string.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : string;
    };
    const render = (data: Record<string, unknown>, indent = ""): string => {
      const lines: string[] = [];
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          if (value.length === 0) lines.push(`${indent}${key}: []`);
          else if (value.every((item) => typeof item !== "object" || item === null)) {
            lines.push(`${indent}${key}: [${value.map(serializeScalar).join(", ")}]`);
          } else {
            lines.push(`${indent}${key}:`);
            for (const item of value) {
              if (Predicate.isObject(item)) {
                const nested = render(item, `${indent}    `).split("\n").filter(Boolean);
                lines.push(`${indent}  - ${nested[0]!.trim()}`);
                for (const line of nested.slice(1)) lines.push(`${indent}    ${line.trim()}`);
              } else lines.push(`${indent}  - ${serializeScalar(item)}`);
            }
          }
        } else if (Predicate.isObject(value)) {
          lines.push(`${indent}${key}:`);
          lines.push(render(value, `${indent}  `));
        } else lines.push(`${indent}${key}: ${serializeScalar(value)}`);
      }
      return `${lines.join("\n")}\n`;
    };
    const serialize = Effect.fn("CollectionYamlSerializerService.serialize")(function* (
      data: Record<string, unknown>,
      indent = "",
    ) {
      return render(data, indent);
    });
    return { serialize } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CollectionYamlSerializerService,
    CollectionYamlSerializerService.make,
  );
}

export class FrontmatterCodecService extends Context.Service<
  FrontmatterCodecService,
  {
    readonly parse: (
      content: string,
    ) => Effect.Effect<{ data: Record<string, unknown>; body: string }>;
    readonly serialize: (data: Record<string, unknown>, body: string) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/collections/FrontmatterCodecService", {
  make: Effect.gen(function* () {
    const parser = yield* CollectionYamlParserService;
    const serializer = yield* CollectionYamlSerializerService;
    const pattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const parse = Effect.fn("FrontmatterCodecService.parse")(function* (content: string) {
      const match = content.match(pattern);
      return match
        ? { data: yield* parser.parse(match[1]!), body: match[2]!.replace(/^\n/, "") }
        : { data: {}, body: content };
    });
    const serialize = Effect.fn("FrontmatterCodecService.serialize")(function* (
      data: Record<string, unknown>,
      body: string,
    ) {
      const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
      return `---\n${yield* serializer.serialize(data)}---\n\n${normalizedBody}`;
    });
    return { parse, serialize } as const;
  }),
}) {
  static readonly layer = Layer.effect(FrontmatterCodecService, FrontmatterCodecService.make);
}

export const frontmatterCodecLayer = FrontmatterCodecService.layer.pipe(
  Layer.provide(
    Layer.merge(
      CollectionYamlParserService.layer.pipe(Layer.provide(CollectionYamlScalarService.layer)),
      CollectionYamlSerializerService.layer,
    ),
  ),
);
