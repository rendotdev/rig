import { afterEach, describe, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigLoggerFactory } from "./logger";

class LoggerWorkspaceStore {
  private readonly homes: string[] = [];

  async create(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "rig-logger-"));
    this.homes.push(home);
    return home;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  }
}

const workspaces = new LoggerWorkspaceStore();
const fixedLogNow = () => Date.parse("2026-07-01T00:00:00.000Z");

afterEach(async () => {
  await workspaces.cleanup();
});

describe("rig logger", () => {
  test("writes prefixed pino logs, rolls files, and removes expired files", async () => {
    const home = await workspaces.create();
    const logDir = join(home, "rig", ".logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "old.log"), "old\n", "utf8");
    await utimes(
      join(logDir, "old.log"),
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );

    const factory = new RigLoggerFactory({
      homeDir: home,
      level: "trace",
      maxFileSizeBytes: 180,
      retentionDays: 7,
      now: fixedLogNow,
    });
    factory.app().debug("Debug app line.");
    factory.app("test").info({ ok: true }, "App log line.");
    factory.tool("sample", "echo").info({ key: "value" }, "Tool log line.");
    factory.tool("sample", "echo").warn("Another tool log line that rolls the active log.");
    factory.tool("sample", "echo").error(new Error("boom"), "Tool error line.");

    new RigLoggerFactory({
      homeDir: home,
      level: "info",
      maxFileSizeBytes: 180,
      retentionDays: 7,
      now: fixedLogNow,
    })
      .app("second")
      .info("Second factory line.");

    const entries = (await readdir(logDir)).toSorted();
    expect(entries).not.toContain("old.log");
    expect(entries).toContain("rig.log");
    expect(entries.some((entry) => entry.startsWith("rig-2026-07-01T00-00-00-000Z"))).toBe(true);
    expect(entries.some((entry) => entry.includes("-1.log"))).toBe(true);

    const output = (
      await Promise.all(entries.map((entry) => readFile(join(logDir, entry), "utf8")))
    ).join("\n");
    expect(output).toContain('"prefix":"rig:test"');
    expect(output).toContain('"prefix":"tool:sample.echo"');
    expect(output).toContain("Tool log line.");
    expect(output).toContain('"type":"Error"');
  });

  test("supports disabled logging and environment configuration", async () => {
    const disabledHome = await workspaces.create();
    new RigLoggerFactory({
      homeDir: disabledHome,
      env: { RIG_LOG: "0" } as NodeJS.ProcessEnv,
    })
      .app("disabled")
      .info("This should not be written.");
    expect(existsSync(join(disabledHome, "rig", ".logs"))).toBe(false);

    const envHome = await workspaces.create();
    const logDir = join(envHome, "custom-logs");
    new RigLoggerFactory({
      homeDir: envHome,
      env: {
        RIG_LOG_DIR: logDir,
        RIG_LOG_LEVEL: "debug",
        RIG_LOG_MAX_BYTES: "1000",
        RIG_LOG_RETENTION_DAYS: "7",
      } as NodeJS.ProcessEnv,
    })
      .app("env")
      .debug("Environment configured debug line.");
    expect(await readFile(join(logDir, "rig.log"), "utf8")).toContain(
      "Environment configured debug line.",
    );

    const fallbackHome = await workspaces.create();
    new RigLoggerFactory({
      homeDir: fallbackHome,
      env: {
        RIG_LOG_MAX_BYTES: "not-a-number",
        RIG_LOG_RETENTION_DAYS: "not-a-number",
      } as NodeJS.ProcessEnv,
    })
      .app("fallback")
      .info("Fallback configured line.");
    expect(await readFile(join(fallbackHome, "rig", ".logs", "rig.log"), "utf8")).toContain(
      "Fallback configured line.",
    );
  });
});
