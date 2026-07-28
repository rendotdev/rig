import type { ChildProcess } from "node:child_process";
import { RigErrorClass } from "../../errors/RigError";

const TerminationGraceMs = 100;
const TruncationMarker = "\n[rig: output truncated]";

function decodeUtf8Prefix(params: { buffer: Buffer }): string {
  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  for (let removed = 0; removed <= Math.min(3, params.buffer.byteLength); removed++) {
    try {
      return strictDecoder.decode(params.buffer.subarray(0, params.buffer.byteLength - removed));
    } catch {
      // A UTF-8 code point may be split at the byte boundary. Try the preceding boundary.
    }
  }
  return new TextDecoder().decode(params.buffer);
}

export const BoundedOutputCollectorSingleton = {
  create(params: { maxBytes: number }) {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;

    function capture(captureParams: { buffer: Buffer }): void {
      const remaining = Math.max(0, params.maxBytes - capturedBytes);
      if (remaining > 0) {
        const captured = captureParams.buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (captureParams.buffer.byteLength > remaining) truncated = true;
    }

    function result(_params: {}): string {
      const content = decodeUtf8Prefix({ buffer: Buffer.concat(chunks, capturedBytes) });
      return truncated ? `${content}${TruncationMarker}` : content;
    }

    return { capture, result };
  },
};

type ManagedProcessFactoryDeps = {
  processGroup: boolean;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer: (timer: NodeJS.Timeout) => void;
};

const ManagedProcessFactoryProductionDeps: ManagedProcessFactoryDeps = {
  processGroup: process.platform !== "win32",
  killProcessGroup(pid, signal) {
    process.kill(-pid, signal);
  },
  setTimer(callback, delay) {
    return setTimeout(callback, delay);
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
};

export class ManagedProcessFactoryService {
  protected readonly deps: ManagedProcessFactoryDeps;

  public constructor(deps: ManagedProcessFactoryDeps = ManagedProcessFactoryProductionDeps) {
    this.deps = deps;
  }

  public create(params: { child: ChildProcess; command: string[]; timeoutMs: number }) {
    let timedOut = false;
    let closed = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    let waitPromise: Promise<number> | undefined;

    const signal = (signalParams: { signal: NodeJS.Signals }): void => {
      try {
        /* v8 ignore else -- Windows does not expose POSIX process groups */
        if (this.deps.processGroup && params.child.pid) {
          this.deps.killProcessGroup(params.child.pid, signalParams.signal);
        } else {
          params.child.kill(signalParams.signal);
        }
      } catch {
        /* v8 ignore next -- the process may exit between close detection and signaling */
        return;
      }
    };

    const terminate = (terminateParams: { timedOut: boolean }): void => {
      if (closed) return;
      timedOut = terminateParams.timedOut;
      signal({ signal: "SIGTERM" });
      /* v8 ignore next -- process exit timing before forced escalation differs by platform */
      escalation = this.deps.setTimer(function forceTermination() {
        signal({ signal: "SIGKILL" });
      }, TerminationGraceMs);
    };

    const wait = (_params: {}): Promise<number> => {
      if (waitPromise) return waitPromise;
      params.child.once("error", function captureSpawnError(error) {
        spawnError = error;
      });
      timeout = this.deps.setTimer(function terminateOnTimeout() {
        terminate({ timedOut: true });
      }, params.timeoutMs);

      waitPromise = (async () => {
        const exitCode = await new Promise<number>(function waitForClose(resolveClose) {
          params.child.once("close", function handleClose(code) {
            closed = true;
            resolveClose(code ?? 1);
          });
        });
        if (spawnError) {
          throw new RigErrorClass("SHELL_ERROR", `Command could not start: ${params.command[0]}`, {
            command: params.command,
            message: spawnError.message,
          });
        }
        if (timedOut) {
          throw new RigErrorClass("SHELL_ERROR", `Command timed out after ${params.timeoutMs}ms.`, {
            command: params.command,
          });
        }
        return exitCode;
      })().finally(() => {
        /* v8 ignore else -- every managed process installs a timeout */
        if (timeout) this.deps.clearTimer(timeout);
        if (escalation) this.deps.clearTimer(escalation);
      });
      return waitPromise;
    };

    return {
      wait,
      cancel(_params: {}): void {
        terminate({ timedOut: false });
      },
    };
  }
}

export const ManagedProcessFactory = new ManagedProcessFactoryService();
