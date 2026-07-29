import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { DiscoveredTool } from "../../registry/types/tool-discovery";
import type { ToolDefinition } from "../types/tool-types";

class ToolEnvironmentParserService extends Context.Service<
  ToolEnvironmentParserService,
  {
    readonly parse: (
      source: string,
      path: string,
    ) => Effect.Effect<Record<string, string>, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolEnvironmentParserService", {
  make: Effect.gen(function* () {
    const parseValue = (value: string): string => {
      const trimmed = value.trim();
      if (trimmed.length < 2) return trimmed;
      const quote = trimmed[0];
      const isUnwrapped = (quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote;
      if (isUnwrapped) return trimmed;
      const inner = trimmed.slice(1, -1);
      if (quote === "'") return inner;
      return inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\t", "\t")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\");
    };
    const parse = Effect.fn("ToolEnvironmentParserService.parse")(function* (
      source: string,
      path: string,
    ) {
      const env: Record<string, string> = {};
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        const isBlankOrComment = !trimmed || trimmed.startsWith("#");
        if (isBlankOrComment) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
        if (!match) {
          return yield* new RigError({
            code: "TOOL_INVALID",
            message: "Invalid .env line.",
            details: { path, line: index + 1 },
          });
        }
        env[match[1]!] = parseValue(match[2]!);
      }
      return env;
    });
    return { parse } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolEnvironmentParserService,
    ToolEnvironmentParserService.make,
  );
}

export class ToolEnvironmentService extends Context.Service<
  ToolEnvironmentService,
  {
    readonly parse: (
      source: string,
      path: string,
    ) => Effect.Effect<Record<string, string>, RigError>;
    readonly load: (
      tool: DiscoveredTool,
      definition: ToolDefinition,
    ) => Effect.Effect<unknown, RigError>;
  }
>()("@rendotdev/rig/tools/loading/ToolEnvironmentService", {
  make: Effect.gen(function* () {
    const parser = yield* ToolEnvironmentParserService;
    const toError = (cause: unknown): RigError =>
      cause instanceof RigError
        ? cause
        : new RigError({
            code: "INTERNAL_ERROR",
            message: cause instanceof Error ? cause.message : String(cause),
          });
    const parse = Effect.fn("ToolEnvironmentService.parse")(function* (
      source: string,
      path: string,
    ) {
      return yield* parser.parse(source, path);
    });
    const bunFile = ():
      | ((path: string) => { exists(): Promise<boolean>; text(): Promise<string> })
      | undefined => {
      const candidate = (globalThis as typeof globalThis & { Bun?: { file?: unknown } }).Bun?.file;
      /* v8 ignore next -- Node consumers use the filesystem fallback */
      return typeof candidate === "function" ? (candidate as never) : undefined;
    };

    const load = Effect.fn("ToolEnvironmentService.load")(function* (
      tool: DiscoveredTool,
      definition: ToolDefinition,
    ) {
      const envPath = join(dirname(tool.toolPath), ".env");
      const file = bunFile();
      const fileExists = yield* Effect.tryPromise({
        /* v8 ignore next -- Node consumers use the filesystem fallback */
        try: () => (file ? file(envPath).exists() : Promise.resolve(existsSync(envPath))),
        catch: toError,
      });
      if (!definition.env) {
        if (fileExists) {
          return yield* new RigError({
            code: "TOOL_INVALID",
            message: `Tool ${definition.name} has .env but no env schema.`,
            details: { path: envPath },
          });
        }
        return {};
      }
      const source = fileExists
        ? yield* Effect.tryPromise({
            /* v8 ignore next -- Node consumers use the filesystem fallback */
            try: () => (file ? file(envPath).text() : readFile(envPath, "utf8")),
            catch: toError,
          })
        : "";
      const rawEnv = yield* parse(source, envPath);
      const result = definition.env.safeParse(rawEnv);
      if (!result.success) {
        return yield* new RigError({
          code: "TOOL_INVALID",
          message: `Tool ${definition.name} env is invalid.`,
          details: { path: envPath, errors: result.error.flatten() },
        });
      }
      return result.data;
    });

    return { parse, load } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolEnvironmentService, ToolEnvironmentService.make);
}

export const toolEnvironmentLayer = ToolEnvironmentService.layer.pipe(
  Layer.provide(ToolEnvironmentParserService.layer),
);
