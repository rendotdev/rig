import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { RigError } from "../errors/rig-error";
import { RigLoggerConfigService, RigLoggerService, rigLogDestinationLayer } from "./rig-logger";

const homes: string[] = [];
const fixedNow = Date.parse("2026-07-01T00:00:00.000Z");

const createHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-logger-"));
  homes.push(home);
  return home;
};

const createLoggerLayer = (params: {
  enabled?: boolean;
  level?: string;
  logDir: string;
  maxFileSizeBytes?: number;
  retentionDays?: number;
  nowEpochMs?: number;
}) =>
  RigLoggerService.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(RigLoggerConfigService, {
          enabled: params.enabled ?? true,
          level: params.level ?? "info",
          logDir: params.logDir,
          maxFileSizeBytes: params.maxFileSizeBytes ?? 5 * 1024 * 1024,
          retentionDays: params.retentionDays ?? 7,
          nowEpochMs: params.nowEpochMs ?? fixedNow,
        }),
        rigLogDestinationLayer,
      ),
    ),
  );

const writeLogs = (
  layer: Layer.Layer<RigLoggerService, RigError, never>,
  operation: (service: RigLoggerService["Service"]) => Effect.Effect<void, RigError>,
) => Effect.runPromise(RigLoggerService.use(operation).pipe(Effect.provide(layer)));

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("rig logger", () => {
  test("does not create the log directory until logging is requested", async () => {
    const home = await createHome();
    const logDir = join(home, "rig", ".logs");

    await Effect.runPromise(
      RigLoggerService.use(() => Effect.void).pipe(Effect.provide(createLoggerLayer({ logDir }))),
    );

    expect(existsSync(logDir)).toBe(false);
  });

  test("writes prefixed pino logs, rolls files, and removes expired files", async () => {
    const home = await createHome();
    const logDir = join(home, "rig", ".logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "rig-old.log"), "old\n", "utf8");
    await utimes(
      join(logDir, "rig-old.log"),
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    const layer = createLoggerLayer({
      logDir,
      level: "trace",
      maxFileSizeBytes: 180,
    });
    await writeLogs(layer, (service) =>
      Effect.gen(function* () {
        const app = yield* service.app("test");
        const tool = yield* service.tool("sample", "echo");
        yield* Effect.sync(() => {
          app.debug("Debug app line.");
          app.info({ ok: true }, "App log line.");
          tool.info({ key: "value" }, "Tool log line.");
          tool.warn("Another tool log line that rolls the active log.");
          tool.error(new Error("boom"), "Tool error line.");
        });
      }),
    );

    const entries = (await readdir(logDir)).toSorted();
    expect(entries).not.toContain("rig-old.log");
    expect(entries).toContain("rig.log");
    expect(entries.some((entry) => entry.startsWith("rig-2026-07-01T00-00-00-000Z"))).toBe(true);
    const output = (
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".log"))
          .map((entry) => readFile(join(logDir, entry), "utf8")),
      )
    ).join("\n");
    expect(output).toContain('"prefix":"rig:test"');
    expect(output).toContain('"prefix":"tool:sample.echo"');
    expect(output).toContain('"type":"Error"');
  });

  test("supports disabled and debug logging configurations", async () => {
    const home = await createHome();
    const disabledDir = join(home, "disabled");
    await writeLogs(createLoggerLayer({ enabled: false, logDir: disabledDir }), (service) =>
      service.app("disabled").pipe(
        Effect.tap((logger) => Effect.sync(() => logger.info("This should not be written."))),
        Effect.asVoid,
      ),
    );
    expect(existsSync(disabledDir)).toBe(false);

    const debugDir = join(home, "debug");
    await writeLogs(createLoggerLayer({ logDir: debugDir, level: "debug" }), (service) =>
      service.app("env").pipe(
        Effect.tap((logger) => Effect.sync(() => logger.debug("Configured debug line."))),
        Effect.asVoid,
      ),
    );
    expect(await readFile(join(debugDir, "rig.log"), "utf8")).toContain("Configured debug line.");
  });

  test("recovers an abandoned rotation lock and keeps the active log", async () => {
    const home = await createHome();
    const logDir = join(home, "logs");
    const lockPath = join(logDir, ".rig.log.rotation.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(logDir, "rig.log"), "active\n", "utf8");
    const old = new Date(fixedNow - 60_000);
    await utimes(lockPath, old, old);
    await writeLogs(createLoggerLayer({ logDir }), (service) =>
      service.app("recovery").pipe(
        Effect.tap((logger) => Effect.sync(() => logger.info("Recovered logging."))),
        Effect.asVoid,
      ),
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain("active\n");
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain("Recovered logging.");
  });

  test("preserves every record while separate processes rotate the same log", async () => {
    const home = await createHome();
    const logDir = join(home, "logs");
    const loggerUrl = new URL("./rig-logger.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, processIndex) => {
      const source = `
        import { Effect, Layer } from "effect";
        import { RigLoggerConfigService, RigLoggerService, rigLogDestinationLayer } from ${JSON.stringify(loggerUrl)};
        const layer = RigLoggerService.layer.pipe(Layer.provide(Layer.merge(
          Layer.succeed(RigLoggerConfigService, {
            enabled: true,
            level: "info",
            logDir: ${JSON.stringify(logDir)},
            maxFileSizeBytes: 500,
            retentionDays: 7,
            nowEpochMs: Date.now(),
          }),
          rigLogDestinationLayer,
        )));
        await Effect.runPromise(RigLoggerService.use((service) => Effect.gen(function* () {
          const logger = yield* service.app("child");
          yield* Effect.sync(() => {
            for (let line = 0; line < 20; line += 1) logger.info("record-${processIndex}-" + line);
          });
        })).pipe(Effect.provide(layer)));
      `;
      return spawn("bun", ["-e", source], { stdio: "pipe" });
    });
    const exits = await Promise.all(
      children.map(
        (child) =>
          new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          }),
      ),
    );
    expect(exits).toEqual([0, 0, 0, 0]);
    const entries = (await readdir(logDir)).filter((entry) => entry.endsWith(".log"));
    const output = (
      await Promise.all(entries.map((entry) => readFile(join(logDir, entry), "utf8")))
    ).join("\n");
    expect(new Set(output.match(/record-\d+-\d+/gu)).size).toBe(80);
    expect(existsSync(join(logDir, ".rig.log.rotation.lock"))).toBe(false);
  });

  test("rechecks active size after a competing process rotates while waiting", async () => {
    const home = await createHome();
    const logDir = join(home, "logs");
    const lockPath = join(logDir, ".rig.log.rotation.lock");
    const activePath = join(logDir, "rig.log");
    await mkdir(logDir, { recursive: true });
    await writeFile(activePath, "x".repeat(200), "utf8");
    await mkdir(lockPath);
    const source = `
      import { rm, writeFile } from "node:fs/promises";
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(${JSON.stringify(activePath)}, "", "utf8");
      await rm(${JSON.stringify(lockPath)}, { recursive: true, force: true });
    `;
    const child = spawn("bun", ["-e", source], { stdio: "pipe" });
    await writeLogs(createLoggerLayer({ logDir, maxFileSizeBytes: 100 }), (service) =>
      service.app("race").pipe(
        Effect.tap((logger) => Effect.sync(() => logger.info("Written after competing rotation."))),
        Effect.asVoid,
      ),
    );
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exit).toBe(0);
    expect(await readFile(activePath, "utf8")).toContain("Written after competing rotation.");
    expect(existsSync(lockPath)).toBe(false);
  });
});
