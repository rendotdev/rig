import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_TRUNCATION_MAX_BYTES,
  DEFAULT_TRUNCATION_MAX_LINES,
  RigOutputTruncator,
  RigOutputTruncatorClass,
  RigOutputTruncatorService,
  type OutputTruncationOptions,
  type TextTruncationResult,
} from "./truncation";

describe("constants", () => {
  test("DEFAULT_TRUNCATION_MAX_BYTES is 50 KiB", () => {
    expect(DEFAULT_TRUNCATION_MAX_BYTES).toBe(50 * 1024);
  });

  test("DEFAULT_TRUNCATION_MAX_LINES is 2000", () => {
    expect(DEFAULT_TRUNCATION_MAX_LINES).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Deterministic service builder tests
// ---------------------------------------------------------------------------

function defaultTmpDir(): string {
  return "/tmp";
}

async function defaultMkdtemp(): Promise<string> {
  return "/tmp/rig-test-output";
}

async function defaultNodeWriteFile(): Promise<void> {}

function defaultJoinPaths(...parts: string[]): string {
  return parts.join("/");
}

function buildTestService(
  configOverrides: Required<OutputTruncationOptions>,
  overrides: {
    bunWrite?: ((path: string, data: string) => Promise<void>) | undefined;
    nodeWriteFile?: (path: string, data: string) => Promise<void>;
    mkdtemp?: (prefix: string) => Promise<string>;
  } = {},
): RigOutputTruncatorService {
  return new RigOutputTruncatorService({
    params: configOverrides,
    deps: {
      tmpdir: defaultTmpDir,
      mkdtemp: overrides.mkdtemp ?? defaultMkdtemp,
      nodeWriteFile: overrides.nodeWriteFile ?? defaultNodeWriteFile,
      join: defaultJoinPaths,
      encoder: new TextEncoder(),
      decoder: new TextDecoder(),
      getBunWrite: function getBunWrite() {
        return overrides.bunWrite;
      },
    },
  });
}

describe("RigOutputTruncatorService", () => {
  test("returns data unchanged when within both limits", async () => {
    const Service = buildTestService({ maxBytes: 1000, maxLines: 100 });
    const result = await Service.truncateData({ data: { ok: true } });
    expect(result).toEqual({ ok: true });
  });

  test("returns undefined unchanged when data is undefined", async () => {
    const Service = buildTestService({ maxBytes: 100, maxLines: 10 });
    const result = await Service.truncateData({ data: undefined });
    expect(result).toBeUndefined();
  });

  test("returns truncation envelope when data exceeds line limit", async () => {
    const Service = buildTestService({ maxBytes: 10_000, maxLines: 2 });
    const result = (await Service.truncateData({ data: { text: "a\nb\nc\nd" } })) as {
      truncated: boolean;
      omittedLines: number;
      fullOutputPath: string;
      message: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.message).toContain("Output truncated");
  });

  test("returns truncation envelope when data exceeds byte limit", async () => {
    const Service = buildTestService({ maxBytes: 10, maxLines: 1000 });
    const result = (await Service.truncateData({
      data: { text: "this is a fairly long string that will exceed ten bytes" },
    })) as { truncated: boolean; fullOutputPath: string };
    expect(result.truncated).toBe(true);
  });

  test("nodeWriteFile dep is called when bunWrite is absent", async () => {
    const writtenPaths: string[] = [];
    const Service = buildTestService(
      { maxBytes: 5, maxLines: 1 },
      {
        nodeWriteFile: async function nodeWriteFile(path: string) {
          writtenPaths.push(path);
        },
        bunWrite: undefined,
      },
    );
    await Service.truncateData({ data: "truncatable string data" });
    expect(writtenPaths).toHaveLength(1);
  });

  test("bunWrite dep is called instead of nodeWriteFile when provided", async () => {
    const bunCalls: string[] = [];
    const nodeCalls: string[] = [];
    const Service = buildTestService(
      { maxBytes: 5, maxLines: 1 },
      {
        bunWrite: async function bunWrite(path: string) {
          bunCalls.push(path);
        },
        nodeWriteFile: async function nodeWriteFile(path: string) {
          nodeCalls.push(path);
        },
      },
    );
    await Service.truncateData({ data: "truncatable string data" });
    expect(bunCalls).toHaveLength(1);
    expect(nodeCalls).toHaveLength(0);
  });

  test("truncation envelope contains all expected fields", async () => {
    const Service = buildTestService({ maxBytes: 10, maxLines: 1000 });
    const result = (await Service.truncateData({
      data: { text: "very long text here" },
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      truncated: true,
      strategy: "head",
      previewFormat: "partial-json",
      fullOutputFormat: "json",
      maxBytes: 10,
      maxLines: 1000,
    });
    expect(typeof result.preview).toBe("string");
    expect(typeof result.fullOutputPath).toBe("string");
    expect(typeof result.totalBytes).toBe("number");
    expect(typeof result.shownBytes).toBe("number");
    expect(typeof result.omittedBytes).toBe("number");
    expect(typeof result.message).toBe("string");
  });
});

describe("RigOutputTruncatorService", () => {
  test("production service is built with default limits", async () => {
    const result = await RigOutputTruncator.truncateData({ data: { ok: true } });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Class-free adapter tests
// ---------------------------------------------------------------------------

describe("RigOutputTruncatorClass adapter", () => {
  test("new RigOutputTruncatorClass() returns a usable instance", async () => {
    const truncator = new RigOutputTruncatorClass({ maxBytes: 1000, maxLines: 100 });
    const result = await truncator.truncateData({ ok: true });
    expect(result).toEqual({ ok: true });
  });

  test("instanceof RigOutputTruncatorClass is true for instances", () => {
    const truncator = new RigOutputTruncatorClass();
    expect(truncator instanceof RigOutputTruncatorClass).toBe(true);
  });

  test("adapter with default options delegates to production service", async () => {
    const truncator = new RigOutputTruncatorClass();
    const result = await truncator.truncateData({ small: "data" });
    expect(result).toEqual({ small: "data" });
  });

  test("adapter exposes truncator compat helper with truncate method", () => {
    const truncator = new RigOutputTruncatorClass({ maxBytes: 10, maxLines: 2 });
    const truncatorHelper = (
      truncator as unknown as {
        truncator: {
          truncate(value: string, options: Required<OutputTruncationOptions>): TextTruncationResult;
        };
      }
    ).truncator;
    expect(truncatorHelper.truncate("", { maxBytes: 10, maxLines: 10 })).toMatchObject({
      totalBytes: 0,
      totalLines: 0,
      truncated: false,
    });
    expect(truncatorHelper.truncate("abc", { maxBytes: 2, maxLines: 10 })).toMatchObject({
      truncated: true,
    });
  });

  test("adapter exposes sizeFormatter compat helper with format method", () => {
    const truncator = new RigOutputTruncatorClass();
    const formatter = (truncator as unknown as { sizeFormatter: { format(bytes: number): string } })
      .sizeFormatter;
    expect(formatter.format(500)).toBe("500B");
    expect(formatter.format(1536)).toBe("1.5KB");
    expect(formatter.format(3 * 1024 * 1024)).toBe("3.0MB");
  });

  test("no-arg constructor uses default limits", async () => {
    const truncator = new RigOutputTruncatorClass();
    const tiny = await truncator.truncateData({ tiny: true });
    expect(tiny).toEqual({ tiny: true });
  });
});
