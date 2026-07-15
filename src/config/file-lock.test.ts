import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { AtomicFileWriterClass, BoundedFileLockClass } from "./file-lock";

class LockTestDirectories {
  private readonly paths: string[] = [];

  async create(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-file-lock-test-"));
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

const directories = new LockTestDirectories();

afterEach(async () => {
  await directories.cleanup();
});

async function createStaleLock(target: string, ownerSource: string): Promise<string> {
  const lockPath = `${target}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), ownerSource, "utf8");
  await utimes(lockPath, new Date(0), new Date(0));
  return lockPath;
}

describe("bounded file lock", () => {
  test("releases after operation failures and missing lock directories", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;
    const lock = new BoundedFileLockClass(target);

    await expect(
      lock.run(() => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      lock.run(async () => {
        await rm(lockPath, { recursive: true });
      }),
    ).resolves.toBeUndefined();
  });

  test("does not release a lock whose ownership token changed", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;

    await new BoundedFileLockClass(target).run(async () => {
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ token: "replacement" })}\n`,
        "utf8",
      );
    });

    expect(existsSync(lockPath)).toBe(true);
    await rm(lockPath, { recursive: true });
  });

  test("propagates malformed lease metadata during release", async () => {
    const directory = await directories.create();
    const target = join(directory, "state.json");
    const lockPath = `${target}.lock`;

    await expect(
      new BoundedFileLockClass(target).run(async () => {
        await writeFile(join(lockPath, "owner.json"), "not json\n", "utf8");
      }),
    ).rejects.toThrow(/JSON|Unexpected token/);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("recovers stale locks with malformed, incomplete, and remote owners", async () => {
    const directory = await directories.create();
    const owners = [
      "not json\n",
      `${JSON.stringify({ token: "missing-fields" })}\n`,
      `${JSON.stringify({
        token: "remote",
        pid: process.pid,
        hostname: `${hostname()}-remote`,
        acquiredAt: new Date(0).toISOString(),
      })}\n`,
    ];

    await Promise.all(
      owners.map(async (owner, index) => {
        const target = join(directory, `state-${index}.json`);
        const lockPath = await createStaleLock(target, owner);
        await new BoundedFileLockClass(target, { staleMs: 1 }).run(() => undefined);
        expect(existsSync(lockPath)).toBe(false);
      }),
    );
  });
});

describe("atomic file writer", () => {
  test("atomically replaces files and cleans temporary files after rename failures", async () => {
    const directory = await directories.create();
    const writer = new AtomicFileWriterClass();
    const target = join(directory, "state.json");
    await writer.write(target, "first\n");
    await writer.write(target, "second\n");
    expect(await readFile(target, "utf8")).toBe("second\n");

    const directoryTarget = join(directory, "cannot-replace");
    await mkdir(directoryTarget);
    await expect(writer.write(directoryTarget, "content\n")).rejects.toThrow(/rename|directory/);
    expect((await readdir(directory)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });
});
