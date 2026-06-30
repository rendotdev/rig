import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class BenchmarkCommand {
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

class RigBenchmarkRunner {
  constructor(
    private readonly entrypoint: string,
    private readonly iterations = 20,
    private readonly warmups = 3,
  ) {}

  async run(command: BenchmarkCommand): Promise<BenchmarkResult> {
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

  spawn(command: BenchmarkCommand): void {
    const result = Bun.spawnSync({
      cmd: [process.execPath, this.entrypoint, ...command.args],
      env: { ...process.env, ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      throw new Error(`${command.name} failed: ${result.stderr.toString()}`);
    }
  }
}

class BenchmarkReporter {
  print(result: BenchmarkResult): void {
    console.log(
      `${result.name.padEnd(22)} min=${result.min.toFixed(1)}ms p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms mean=${result.mean.toFixed(1)}ms`,
    );
  }
}

class RigBenchmarkSuite {
  private readonly entrypoint = process.env.RIG_BENCH_ENTRY ?? "src/cli.ts";
  private readonly iterations = Number(process.env.RIG_BENCH_ITERATIONS ?? 20);
  private readonly runner = new RigBenchmarkRunner(this.entrypoint, this.iterations);
  private readonly reporter = new BenchmarkReporter();

  async run(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "rig-bench-home-"));
    try {
      this.runner.spawn(
        new BenchmarkCommand("setup", ["create", "sample"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
      );

      const commands = [
        new BenchmarkCommand("config path", ["config", "path"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommand("list", ["list"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommand("help command", ["help", "sample.example"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
        new BenchmarkCommand("run command", ["run", "sample.example", "Agent"], {
          RIG_HOME: home,
          RIG_AGENT_SYNC: "0",
        }),
      ];

      if (process.env.RIG_BENCH_TYPECHECK === "1") {
        commands.push(
          new BenchmarkCommand("typecheck", ["typecheck", "sample"], {
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
}

await new RigBenchmarkSuite().run();
