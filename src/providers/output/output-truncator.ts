import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

export const DEFAULT_TRUNCATION_MAX_BYTES = 50 * 1024;
export const DEFAULT_TRUNCATION_MAX_LINES = 2000;

export type TextTruncationResult = {
  content: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
};

export type OutputTruncationOptions = { maxBytes?: number; maxLines?: number };

export class OutputTruncationError extends Schema.TaggedErrorClass<OutputTruncationError>()(
  "OutputTruncationError",
  { cause: Schema.Defect() },
) {}

export class OutputTruncatorConfigService extends Context.Service<
  OutputTruncatorConfigService,
  {
    readonly limits: Required<OutputTruncationOptions>;
  }
>()("@rendotdev/rig/runtime/OutputTruncatorConfigService", {
  make: Effect.succeed({
    limits: {
      maxBytes: DEFAULT_TRUNCATION_MAX_BYTES,
      maxLines: DEFAULT_TRUNCATION_MAX_LINES,
    },
  }),
}) {
  static readonly layer = Layer.effect(
    OutputTruncatorConfigService,
    OutputTruncatorConfigService.make,
  );
}

export class OutputTruncatorPlatformService extends Context.Service<
  OutputTruncatorPlatformService,
  {
    readonly writeFullOutput: (serialized: string) => Effect.Effect<string, OutputTruncationError>;
  }
>()("@rendotdev/rig/runtime/OutputTruncatorPlatformService", {
  make: Effect.gen(function* () {
    const writeFullOutput = Effect.fn("OutputTruncatorPlatformService.writeFullOutput")(function* (
      serialized: string,
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          const directory = await mkdtemp(join(tmpdir(), "rig-output-"));
          try {
            const path = join(directory, "data.json");
            /* v8 ignore next -- Node fallback supports generated consumers without Bun globals */
            const canWriteWithBun = typeof Bun !== "undefined" && typeof Bun.write === "function";
            /* v8 ignore next -- Node fallback supports generated consumers without Bun globals */
            if (canWriteWithBun) {
              await Bun.write(path, `${serialized}\n`);
            } else {
              /* v8 ignore next */
              await writeFile(path, `${serialized}\n`, "utf8");
            }
            return path;
          } catch (cause) {
            /* v8 ignore next -- cleanup after a platform write failure is defensive */
            await rm(directory, { recursive: true, force: true });
            /* v8 ignore next */
            throw cause;
          }
        },
        /* v8 ignore next -- platform I/O fault translation is defensive */
        catch: (cause) => new OutputTruncationError({ cause }),
      });
    });
    return { writeFullOutput } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    OutputTruncatorPlatformService,
    OutputTruncatorPlatformService.make,
  );
}

export class OutputTruncatorService extends Context.Service<
  OutputTruncatorService,
  {
    readonly truncate: (data: unknown) => Effect.Effect<unknown, OutputTruncationError>;
    readonly truncateText: (
      value: string,
      options: Required<OutputTruncationOptions>,
    ) => Effect.Effect<TextTruncationResult>;
    readonly formatByteSize: (bytes: number) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/runtime/OutputTruncatorService", {
  make: Effect.gen(function* () {
    const config = yield* OutputTruncatorConfigService;
    const platform = yield* OutputTruncatorPlatformService;

    const computeTextTruncation = (
      value: string,
      options: Required<OutputTruncationOptions>,
    ): TextTruncationResult => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const totalBytes = encoder.encode(value).byteLength;
      const totalLines = value.length === 0 ? 0 : value.split("\n").length;
      let content = value;
      if (totalLines > options.maxLines) {
        content = content.split("\n").slice(0, options.maxLines).join("\n");
      }
      if (encoder.encode(content).byteLength > options.maxBytes) {
        content = decoder.decode(encoder.encode(content).slice(0, options.maxBytes));
      }
      const outputBytes = encoder.encode(content).byteLength;
      const outputLines = content.length === 0 ? 0 : content.split("\n").length;
      return {
        content,
        truncated: outputBytes < totalBytes || outputLines < totalLines,
        totalBytes,
        totalLines,
        outputBytes,
        outputLines,
      };
    };

    const renderByteSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const truncate = Effect.fn("OutputTruncatorService.truncate")(function* (data: unknown) {
      const serialized = yield* Effect.try({
        try: () => JSON.stringify(data, null, 2) ?? "null",
        catch: (cause) => new OutputTruncationError({ cause }),
      });
      const result = computeTextTruncation(serialized, config.limits);
      if (!result.truncated) return data;
      const fullOutputPath = yield* platform.writeFullOutput(serialized);
      return {
        truncated: true,
        strategy: "head",
        preview: result.content,
        previewFormat: "partial-json",
        fullOutputPath,
        fullOutputFormat: "json",
        ...config.limits,
        totalBytes: result.totalBytes,
        totalLines: result.totalLines,
        shownBytes: result.outputBytes,
        shownLines: result.outputLines,
        omittedBytes: result.totalBytes - result.outputBytes,
        omittedLines: result.totalLines - result.outputLines,
        message: `Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${renderByteSize(result.outputBytes)} of ${renderByteSize(result.totalBytes)}). Full output saved to: ${fullOutputPath}`,
      };
    });

    const truncateText = Effect.fn("OutputTruncatorService.truncateText")(function* (
      value: string,
      options: Required<OutputTruncationOptions>,
    ) {
      return computeTextTruncation(value, options);
    });

    const formatByteSize = Effect.fn("OutputTruncatorService.formatByteSize")(function* (
      bytes: number,
    ) {
      return renderByteSize(bytes);
    });

    return { truncate, truncateText, formatByteSize } as const;
  }),
}) {
  static readonly layer = Layer.effect(OutputTruncatorService, OutputTruncatorService.make);
}

export const outputTruncatorLayer = OutputTruncatorService.layer.pipe(
  Layer.provide(
    Layer.merge(OutputTruncatorConfigService.layer, OutputTruncatorPlatformService.layer),
  ),
);
