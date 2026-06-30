import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

class TextMetrics {
  private readonly encoder = new TextEncoder();

  byteLength(value: string): number {
    return this.encoder.encode(value).byteLength;
  }

  lineCount(value: string): number {
    if (value.length === 0) return 0;
    return value.split("\n").length;
  }
}

class TextHeadTruncator {
  private readonly metrics = new TextMetrics();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  truncate(value: string, options: Required<OutputTruncationOptions>): TextTruncationResult {
    const totalBytes = this.metrics.byteLength(value);
    const totalLines = this.metrics.lineCount(value);
    let content = value;

    if (totalLines > options.maxLines) {
      content = content.split("\n").slice(0, options.maxLines).join("\n");
    }

    if (this.metrics.byteLength(content) > options.maxBytes) {
      content = this.decoder.decode(this.encoder.encode(content).slice(0, options.maxBytes));
    }

    const outputBytes = this.metrics.byteLength(content);
    const outputLines = this.metrics.lineCount(content);

    return {
      content,
      truncated: outputBytes < totalBytes || outputLines < totalLines,
      totalBytes,
      totalLines,
      outputBytes,
      outputLines,
    };
  }
}

class OutputTempFileStore {
  async writeJson(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rig-output-"));
    const path = join(dir, "data.json");
    /* v8 ignore next 3 */
    if (typeof Bun !== "undefined") await Bun.write(path, `${content}\n`);
    else await writeFile(path, `${content}\n`, "utf8");
    return path;
  }
}

class JsonDataSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? "null";
  }
}

class SizeFormatter {
  format(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

export class RigOutputTruncator {
  private readonly options: Required<OutputTruncationOptions>;
  private readonly serializer = new JsonDataSerializer();
  private readonly truncator = new TextHeadTruncator();
  private readonly store = new OutputTempFileStore();
  private readonly sizeFormatter = new SizeFormatter();

  constructor(options: OutputTruncationOptions = {}) {
    this.options = {
      maxBytes: options.maxBytes ?? DEFAULT_TRUNCATION_MAX_BYTES,
      maxLines: options.maxLines ?? DEFAULT_TRUNCATION_MAX_LINES,
    };
  }

  async truncateData(data: unknown): Promise<unknown> {
    const serialized = this.serializer.serialize(data);
    const truncation = this.truncator.truncate(serialized, this.options);
    if (!truncation.truncated) return data;

    const fullOutputPath = await this.store.writeJson(serialized);
    const omittedBytes = truncation.totalBytes - truncation.outputBytes;
    const omittedLines = truncation.totalLines - truncation.outputLines;

    return {
      truncated: true,
      strategy: "head",
      preview: truncation.content,
      previewFormat: "partial-json",
      fullOutputPath,
      fullOutputFormat: "json",
      maxBytes: this.options.maxBytes,
      maxLines: this.options.maxLines,
      totalBytes: truncation.totalBytes,
      totalLines: truncation.totalLines,
      shownBytes: truncation.outputBytes,
      shownLines: truncation.outputLines,
      omittedBytes,
      omittedLines,
      message: `Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${this.sizeFormatter.format(truncation.outputBytes)} of ${this.sizeFormatter.format(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}`,
    };
  }
}
