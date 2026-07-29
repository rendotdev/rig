import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_TRUNCATION_MAX_BYTES,
  DEFAULT_TRUNCATION_MAX_LINES,
  OutputTruncatorConfigService,
  OutputTruncatorPlatformService,
  OutputTruncatorService,
  outputTruncatorLayer,
} from "./output-truncator";

describe("output truncation", () => {
  test("uses the documented defaults", () => {
    expect(DEFAULT_TRUNCATION_MAX_BYTES).toBe(50 * 1024);
    expect(DEFAULT_TRUNCATION_MAX_LINES).toBe(2000);
  });

  test("returns data unchanged within limits", async () => {
    await expect(
      Effect.runPromise(
        OutputTruncatorService.use((service) => service.truncate({ ok: true })).pipe(
          Effect.provide(outputTruncatorLayer),
        ),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      Effect.runPromise(
        OutputTruncatorService.use((service) => service.truncate(undefined)).pipe(
          Effect.provide(outputTruncatorLayer),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  test("writes full output and returns truncation metadata", async () => {
    const writes: string[] = [];
    const layer = OutputTruncatorService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(OutputTruncatorConfigService, {
            limits: { maxBytes: 10, maxLines: 2 },
          }),
          Layer.succeed(OutputTruncatorPlatformService, {
            writeFullOutput: Effect.fn("OutputTruncatorPlatformService.writeFullOutput")(
              function* () {
                const path = "/tmp/rig-test-output/data.json";
                writes.push(path);
                return path;
              },
            ),
          }),
        ),
      ),
    );
    await expect(
      Effect.runPromise(
        OutputTruncatorService.use((service) =>
          service.truncate({ text: "a\nb\nc\nd and more" }),
        ).pipe(Effect.provide(layer)),
      ),
    ).resolves.toMatchObject({
      truncated: true,
      strategy: "head",
      previewFormat: "partial-json",
      fullOutputFormat: "json",
      maxBytes: 10,
      maxLines: 2,
    });
    expect(writes).toEqual(["/tmp/rig-test-output/data.json"]);
  });

  test("exposes text and byte formatting through the service", () => {
    const run = <Result>(
      operation: (service: OutputTruncatorService["Service"]) => Effect.Effect<Result>,
    ) =>
      Effect.runSync(
        OutputTruncatorService.use(operation).pipe(Effect.provide(outputTruncatorLayer)),
      );
    expect(
      run((service) => service.truncateText("", { maxBytes: 10, maxLines: 10 })),
    ).toMatchObject({
      totalBytes: 0,
      totalLines: 0,
      truncated: false,
    });
    expect(
      run((service) => service.truncateText("abcdef", { maxBytes: 3, maxLines: 10 })),
    ).toMatchObject({ content: "abc", truncated: true });
    expect(run((service) => service.formatByteSize(500))).toBe("500B");
    expect(run((service) => service.formatByteSize(1536))).toBe("1.5KB");
    expect(run((service) => service.formatByteSize(3 * 1024 * 1024))).toBe("3.0MB");
  });
});
