import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vite-plus/test";
import { ManagedProcessFactoryService } from "./managed-process";

describe("managed process lifecycle", () => {
  it("memoizes waits, escalates cancellation, and ignores cancellation after close", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 42 });
    child.kill = vi.fn(() => true);
    const timers: Array<{ callback: () => void; timer: NodeJS.Timeout }> = [];
    const factory = new ManagedProcessFactoryService({
      processGroup: false,
      killProcessGroup: vi.fn(),
      setTimer(callback) {
        const timer = {} as NodeJS.Timeout;
        timers.push({ callback, timer });
        return timer;
      },
      clearTimer: vi.fn(),
    });
    const managed = factory.create({ child, command: ["example"], timeoutMs: 1_000 });

    const firstWait = managed.wait({});
    expect(managed.wait({})).toBe(firstWait);
    managed.cancel({});
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    timers[1]!.callback();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", 0);
    await expect(firstWait).resolves.toBe(0);
    managed.cancel({});
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});
