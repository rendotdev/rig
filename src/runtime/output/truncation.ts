import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineService } from "../../define";

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

export type OutputTruncationOptions = {
  maxBytes?: number;
  maxLines?: number;
};

// --- Internal helpers ---

function createTextTruncator(params: { encoder: TextEncoder; decoder: TextDecoder }) {
  function truncate(
    value: string,
    options: Required<OutputTruncationOptions>,
  ): TextTruncationResult {
    const totalBytes = params.encoder.encode(value).byteLength;
    const totalLines = value.length === 0 ? 0 : value.split("\n").length;
    let content = value;

    if (totalLines > options.maxLines) {
      content = content.split("\n").slice(0, options.maxLines).join("\n");
    }

    if (params.encoder.encode(content).byteLength > options.maxBytes) {
      content = params.decoder.decode(params.encoder.encode(content).slice(0, options.maxBytes));
    }

    const outputBytes = params.encoder.encode(content).byteLength;
    const outputLines = content.length === 0 ? 0 : content.split("\n").length;

    return {
      content,
      truncated: outputBytes < totalBytes || outputLines < totalLines,
      totalBytes,
      totalLines,
      outputBytes,
      outputLines,
    };
  }

  return { truncate };
}

const rigTextTruncatorHelper = createTextTruncator({
  encoder: new TextEncoder(),
  decoder: new TextDecoder(),
});

const rigSizeFormatterHelper = {
  format(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  },
};

// --- Bun/Node boundary helper ---

/* v8 ignore next 3 */
function getBunWrite(): ((path: string, data: string) => Promise<void>) | undefined {
  if (typeof Bun === "undefined") return undefined;
  return async function bunWrite(path: string, data: string) {
    await Bun.write(path, data);
  };
}

// --- Service deps ---

const RigOutputTruncatorServiceDeps = {
  tmpdir: function getTmpDir() {
    return tmpdir();
  },
  mkdtemp: async function mkdtempAdapter(prefix: string) {
    return mkdtemp(prefix);
  },
  nodeWriteFile: async function nodeWriteFile(path: string, data: string) {
    await writeFile(path, data, "utf8");
  },
  join: function joinPaths(...paths: string[]) {
    return join(...paths);
  },
  encoder: new TextEncoder(),
  decoder: new TextDecoder(),
  getBunWrite,
};

// --- Serializer ---

function serializeOutputData(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export class RigOutputTruncatorService extends defineService({
  params: {
    maxBytes: DEFAULT_TRUNCATION_MAX_BYTES,
    maxLines: DEFAULT_TRUNCATION_MAX_LINES,
  },
  deps: RigOutputTruncatorServiceDeps,
}) {
  private readonly truncator = createTextTruncator({
    encoder: this.deps.encoder,
    decoder: this.deps.decoder,
  });

  private async writeOutputFile(params: { serialized: string }): Promise<string> {
    const dir = await this.deps.mkdtemp(this.deps.join(this.deps.tmpdir(), "rig-output-"));
    const path = this.deps.join(dir, "data.json");
    const bunWrite = this.deps.getBunWrite();
    if (bunWrite !== undefined) await bunWrite(path, `${params.serialized}\n`);
    else await this.deps.nodeWriteFile(path, `${params.serialized}\n`);
    return path;
  }

  public async truncateData(params: { data: unknown }): Promise<unknown> {
    const serialized = serializeOutputData(params.data);
    const result = this.truncator.truncate(serialized, {
      maxBytes: this.params.maxBytes,
      maxLines: this.params.maxLines,
    });

    if (!result.truncated) return params.data;

    const fullOutputPath = await this.writeOutputFile({ serialized });
    const omittedBytes = result.totalBytes - result.outputBytes;
    const omittedLines = result.totalLines - result.outputLines;

    return {
      truncated: true,
      strategy: "head",
      preview: result.content,
      previewFormat: "partial-json",
      fullOutputPath,
      fullOutputFormat: "json",
      maxBytes: this.params.maxBytes,
      maxLines: this.params.maxLines,
      totalBytes: result.totalBytes,
      totalLines: result.totalLines,
      shownBytes: result.outputBytes,
      shownLines: result.outputLines,
      omittedBytes,
      omittedLines,
      message: `Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${rigSizeFormatterHelper.format(result.outputBytes)} of ${rigSizeFormatterHelper.format(result.totalBytes)}). Full output saved to: ${fullOutputPath}`,
    };
  }
}

export const RigOutputTruncator = new RigOutputTruncatorService();

// --- Class-free adapter (backward compatibility) ---

type RigOutputTruncatorCompatibility = {
  truncateData(data: unknown): Promise<unknown>;
};

type RigOutputTruncatorConstructor = {
  new (options?: OutputTruncationOptions): RigOutputTruncatorCompatibility;
  readonly prototype: RigOutputTruncatorCompatibility;
};

function RigOutputTruncatorClassAdapter(options: OutputTruncationOptions = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_TRUNCATION_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_TRUNCATION_MAX_LINES;

  const service =
    maxBytes === DEFAULT_TRUNCATION_MAX_BYTES && maxLines === DEFAULT_TRUNCATION_MAX_LINES
      ? RigOutputTruncator
      : new RigOutputTruncatorService({
          params: { maxBytes, maxLines },
          deps: RigOutputTruncatorServiceDeps,
        });

  const adapter = Object.create(RigOutputTruncatorClassAdapter.prototype) as Record<
    string,
    unknown
  >;
  Object.defineProperties(adapter, {
    truncateData: {
      configurable: true,
      value: function truncateData(data: unknown) {
        return service.truncateData({ data });
      },
      writable: true,
    },
    truncator: { configurable: true, value: rigTextTruncatorHelper, writable: true },
    sizeFormatter: { configurable: true, value: rigSizeFormatterHelper, writable: true },
  });
  return adapter;
}

export const RigOutputTruncatorClass =
  RigOutputTruncatorClassAdapter as unknown as RigOutputTruncatorConstructor;
