import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class BenchmarkCommandClass {
  constructor(
    readonly name: string,
    readonly args: string[],
    readonly env: Record<string, string | undefined> = {},
  ) {}
}

type BenchmarkResult = {
  name: string;
  min: number;
  p50: number;
  p95: number;
  mean: number;
};

class RigBenchmarkRunnerClass {
  constructor(
    private readonly entrypoint: string,
    private readonly iterations = 20,
    private readonly warmups = 3,
  ) {}

  async run(command: BenchmarkCommandClass): Promise<BenchmarkResult> {
    for (let index = 0; index < this.warmups; index++) this.spawn(command);

    const times: number[] = [];
    for (let index = 0; index < this.iterations; index++) {
      const started = performance.now();
      this.spawn(command);
      times.push(performance.now() - started);
    }

    times.sort((left, right) => left - right);
    return {
      name: command.name,
      min: times[0] ?? 0,
      p50: times[Math.floor(times.length * 0.5)] ?? 0,
      p95: times[Math.floor(times.length * 0.95)] ?? 0,
      mean: times.reduce((total, value) => total + value, 0) / times.length,
    };
  }

  spawn(command: BenchmarkCommandClass): void {
    const result = Bun.spawnSync({
      cmd: ["node", this.entrypoint, ...command.args],
      env: { ...process.env, ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      throw new Error(`${command.name} failed: ${result.stderr.toString()}`);
    }
  }
}

class BenchmarkReporterClass {
  print(result: BenchmarkResult): void {
    console.log(
      `${result.name.padEnd(22)} min=${result.min.toFixed(1)}ms p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms mean=${result.mean.toFixed(1)}ms`,
    );
  }
}

export class RigBenchmarkSuiteClass {
  private readonly entrypoint = process.env.RIG_BENCH_ENTRY ?? "dist/rig.mjs";
  private readonly iterations = Number(process.env.RIG_BENCH_ITERATIONS ?? 20);
  private readonly runner = new RigBenchmarkRunnerClass(this.entrypoint, this.iterations);
  private readonly reporter = new BenchmarkReporterClass();

  async run(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "rig-bench-home-"));
    try {
      this.runner.spawn(
        new BenchmarkCommandClass("setup", ["create", "sample"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
      );
      await this.createNestedBenchmarkTools(home);

      const commands = [
        new BenchmarkCommandClass("config path", ["config", "path"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommandClass("list", ["list"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommandClass("help command", ["help", "sample.example"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommandClass("run command", ["run", "sample.example", "Agent"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommandClass(
          "nested run (50)",
          ["run", "caller.call", "--input", JSON.stringify({ count: 50 })],
          { RIG_HOME: home, RIG_AGENT_SYNC: "0" },
        ),
      ];

      if (process.env.RIG_BENCH_TYPECHECK === "1") {
        commands.push(
          new BenchmarkCommandClass("typecheck", ["typecheck", "sample"], {
            RIG_HOME: home,
            RIG_AGENT_SYNC: "0",
          }),
        );
      }

      console.log(`Entrypoint: ${this.entrypoint}`);
      console.log(`Iterations: ${this.iterations}`);
      await commands.reduce(async (previous, command) => {
        await previous;
        this.reporter.print(await this.runner.run(command));
      }, Promise.resolve());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  private async createNestedBenchmarkTools(home: string): Promise<void> {
    const toolsDir = join(home, "rig", "tools");
    const calleeDir = join(toolsDir, "callee");
    const callerDir = join(toolsDir, "caller");
    await Promise.all([
      mkdir(calleeDir, { recursive: true }),
      mkdir(callerDir, { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(
        join(calleeDir, "index.rig.ts"),
        `export default (rig) => rig.defineTool({
  name: "callee",
  description: "Nested benchmark callee.",
  commands: {
    read: rig.defineCommand({
      description: "Return one.",
      input: rig.z.object({}),
      output: rig.z.number(),
      run: () => 1,
    }),
  },
});
`,
      ),
      Bun.write(
        join(callerDir, "index.rig.ts"),
        `export default (rig) => rig.defineTool({
  name: "caller",
  description: "Nested benchmark caller.",
  commands: {
    call: rig.defineCommand({
      description: "Call another tool repeatedly.",
      input: rig.z.object({ count: rig.z.number() }),
      output: rig.z.array(rig.z.number()),
      run: async (context) => {
        const values = [];
        for (let index = 0; index < context.input.count; index++) {
          values.push(await context.rig.run({ command: "callee.read" }));
        }
        return values;
      },
    }),
  },
});
`,
      ),
    ]);
  }
}
