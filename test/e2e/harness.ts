import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RigE2ECommandParams = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};

export type RigE2ERuntime = "bun" | "direct" | "node";

export type RigE2ECommandResult = {
  command: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  json<T = unknown>(): T;
};

type RigE2EHarnessDeps = {
  now: () => number;
};

type BunFileRuntime = {
  file(path: string): { exists(): Promise<boolean>; text(): Promise<string> };
  write(path: string, content: string): Promise<number>;
};

class RigE2ECommandResultClass implements RigE2ECommandResult {
  public readonly command: string[];
  public readonly cwd: string;
  public readonly exitCode: number;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly durationMs: number;

  constructor(params: {
    command: string[];
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }) {
    this.command = params.command;
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.durationMs = params.durationMs;
  }

  public json<T = unknown>(): T {
    try {
      return JSON.parse(this.stdout.trim()) as T;
    } catch (error) {
      throw new Error(
        [
          `Could not parse Rig stdout as JSON: ${this.command.join(" ")}`,
          `cwd: ${this.cwd}`,
          `exit: ${this.exitCode}`,
          `stdout:\n${this.stdout || "<empty>"}`,
          `stderr:\n${this.stderr || "<empty>"}`,
          `parse error: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
        { cause: error },
      );
    }
  }
}

export class RigE2EHarnessClass {
  public readonly rootDir: string;
  public readonly homeDir: string;
  public readonly rigHomeDir: string;
  public readonly projectDir: string;
  public readonly cliPath: string;
  public readonly runtime: RigE2ERuntime;

  public constructor(
    params: {
      rootDir: string;
      homeDir: string;
      rigHomeDir: string;
      projectDir: string;
      cliPath: string;
      runtime: RigE2ERuntime;
    },
    private readonly deps: RigE2EHarnessDeps,
  ) {
    this.rootDir = params.rootDir;
    this.homeDir = params.homeDir;
    this.rigHomeDir = params.rigHomeDir;
    this.projectDir = params.projectDir;
    this.cliPath = params.cliPath;
    this.runtime = params.runtime;
  }

  public async run(params: RigE2ECommandParams = {}): Promise<RigE2ECommandResult> {
    const command =
      this.runtime === "direct"
        ? [this.cliPath, ...(params.args ?? [])]
        : [this.runtime, this.cliPath, ...(params.args ?? [])];
    const cwd = params.cwd ?? this.projectDir;
    const startedAt = this.deps.now();
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: {
        ...this.processEnv(),
        HOME: this.homeDir,
        RIG_HOME: this.rigHomeDir,
        RIG_AGENT_SYNC: "0",
        RIG_UPDATE_CHECK: "0",
        NO_COLOR: "1",
        ...params.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.end(params.stdin);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const timeoutMs = params.timeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const exitCode = await Promise.race([
        new Promise<number>((resolveExit, rejectExit) => {
          child.once("error", rejectExit);
          child.once("close", (code, signal) => {
            if (code !== null) resolveExit(code);
            else rejectExit(new Error(`Rig E2E command ended from signal ${signal ?? "unknown"}.`));
          });
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
              new Error(
                `Rig E2E command timed out after ${timeoutMs}ms: ${command.join(" ")}\ncwd: ${cwd}`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      return new RigE2ECommandResultClass({
        command,
        cwd,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: this.deps.now() - startedAt,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async writeProjectFile(relativePath: string, content: string): Promise<string> {
    return this.writeFile(join(this.projectDir, relativePath), content);
  }

  public async writeRigFile(relativePath: string, content: string): Promise<string> {
    return this.writeFile(join(this.rigHomeDir, relativePath), content);
  }

  public async writeTool(params: { name: string; source: string }): Promise<string> {
    return this.writeRigFile(join("rig", "tools", params.name, "index.rig.ts"), params.source);
  }

  public async read(path: string): Promise<string> {
    const bun = this.bunRuntime();
    return bun ? bun.file(path).text() : readFile(path, "utf8");
  }

  public async write(path: string, content: string): Promise<string> {
    return this.writeFile(path, content);
  }

  public async exists(path: string): Promise<boolean> {
    const bun = this.bunRuntime();
    return bun ? bun.file(path).exists() : existsSync(path);
  }

  public async cleanup(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private async writeFile(path: string, content: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const bun = this.bunRuntime();
    if (bun) await bun.write(path, content);
    else await writeFile(path, content, "utf8");
    return path;
  }

  private bunRuntime(): BunFileRuntime | undefined {
    const candidate = (globalThis as typeof globalThis & { Bun?: BunFileRuntime }).Bun;
    return candidate;
  }

  private processEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[0] !== "FORCE_COLOR" && entry[1] !== undefined,
      ),
    );
  }
}

export class RigE2EHarnessFactoryClass {
  constructor(
    private readonly params: { cliPath?: string; runtime?: RigE2ERuntime } = {},
    private readonly deps: RigE2EHarnessDeps = { now: Date.now },
  ) {}

  public async create(): Promise<RigE2EHarnessClass> {
    const harnessDir = dirname(fileURLToPath(import.meta.url));
    const cliPath = resolve(this.params.cliPath ?? join(harnessDir, "..", "..", "dist", "rig.mjs"));
    if (!existsSync(cliPath)) {
      throw new Error(
        `Built Rig CLI is missing at ${cliPath}. Run \`vp run build\` before E2E tests.`,
      );
    }

    const rootDir = await mkdtemp(join(tmpdir(), "rig-e2e-"));
    const paths = {
      rootDir,
      homeDir: join(rootDir, "home"),
      rigHomeDir: join(rootDir, "rig-home"),
      projectDir: join(rootDir, "project"),
      cliPath,
      runtime: this.params.runtime ?? "bun",
    };
    await Promise.all([
      mkdir(paths.homeDir, { recursive: true }),
      mkdir(paths.rigHomeDir, { recursive: true }),
      mkdir(paths.projectDir, { recursive: true }),
    ]);
    return new RigE2EHarnessClass(paths, this.deps);
  }
}

export const rigE2EHarnessFactory = new RigE2EHarnessFactoryClass();
