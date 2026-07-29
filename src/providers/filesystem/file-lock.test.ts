import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  AtomicFileWriterError,
  atomicFileWriterLayer,
  AtomicFileWriterService,
} from "./atomic-file-writer";
import { fileLockLayer, FileLockService } from "./file-lock";

describe("FileLockService", () => {
  test("runs an operation under a lock and releases the lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-file-lock-test-"));
    const target = join(directory, "state.json");
    try {
      const result = await Effect.gen(function* () {
        const locks = yield* FileLockService;
        return yield* locks.withLock({
          targetPath: target,
          operation: () => Effect.succeed("done"),
        });
      }).pipe(Effect.provide(fileLockLayer), Effect.runPromise);

      expect(result).toBe("done");
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("releases the lease when the protected operation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-file-lock-test-"));
    const target = join(directory, "state.json");
    try {
      const program = Effect.gen(function* () {
        const locks = yield* FileLockService;
        return yield* locks.withLock({
          targetPath: target,
          operation: () => Effect.die(new Error("operation failed")),
        });
      }).pipe(Effect.provide(fileLockLayer), Effect.runPromise);

      await expect(program).rejects.toThrow("operation failed");
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers an abandoned stale lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-file-lock-test-"));
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), "not json\n", "utf8");
      const old = new Date(0);
      await utimes(lockPath, old, old);

      await Effect.gen(function* () {
        const locks = yield* FileLockService;
        yield* locks.withLock({
          targetPath: target,
          options: { staleMs: 1 },
          operation: () => Effect.void,
        });
      }).pipe(Effect.provide(fileLockLayer), Effect.runPromise);

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("AtomicFileWriterService", () => {
  test("atomically replaces files and creates parent directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-atomic-writer-test-"));
    const target = join(directory, "nested", "state.json");
    try {
      await Effect.gen(function* () {
        const writer = yield* AtomicFileWriterService;
        yield* writer.write(target, "first\n");
        yield* writer.write(target, "second\n");
      }).pipe(Effect.provide(atomicFileWriterLayer), Effect.runPromise);

      expect(await readFile(target, "utf8")).toBe("second\n");
      expect(
        (await readdir(join(directory, "nested"))).filter((name) => name.includes(".tmp-")),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cleans its temporary file when replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rig-atomic-writer-test-"));
    const target = join(directory, "cannot-replace");
    try {
      await mkdir(target);
      const program = Effect.gen(function* () {
        const writer = yield* AtomicFileWriterService;
        yield* writer.write(target, "content\n");
      }).pipe(Effect.provide(atomicFileWriterLayer), Effect.runPromise);

      await expect(program).rejects.toBeInstanceOf(AtomicFileWriterError);
      expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
