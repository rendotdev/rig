import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BenchmarkRuntime = "bun" | "node";

class BenchmarkCommandClass {
  constructor(
    readonly name: string,
    readonly args: string[],
    readonly env: Record<string, string | undefined> = {},
    readonly p50BudgetMs: Partial<Record<BenchmarkRuntime, number>> = {},
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

  async run(command: BenchmarkCommandClass, runtime: BenchmarkRuntime): Promise<BenchmarkResult> {
    for (let index = 0; index < this.warmups; index++) this.spawn(command, runtime);

    const times: number[] = [];
    for (let index = 0; index < this.iterations; index++) {
      const started = performance.now();
      this.spawn(command, runtime);
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

  spawn(command: BenchmarkCommandClass, runtime: BenchmarkRuntime): void {
    const executable = runtime === "bun" ? process.execPath : "node";
    const result = Bun.spawnSync({
      cmd: [executable, this.entrypoint, ...command.args],
      env: { ...process.env, ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      throw new Error(`${command.name} failed under ${runtime}: ${result.stderr.toString()}`);
    }
  }
}

class BenchmarkReporterClass {
  print(result: BenchmarkResult, runtime: BenchmarkRuntime, budgetMs?: number): void {
    const budget = budgetMs === undefined ? "" : ` budget=${budgetMs.toFixed(0)}ms`;
    console.log(
      `${result.name.padEnd(28)} min=${result.min.toFixed(1)}ms p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms mean=${result.mean.toFixed(1)}ms${budget}`,
    );
    if (budgetMs !== undefined && result.p50 > budgetMs && process.env.RIG_BENCH_ENFORCE !== "0") {
      throw new Error(
        `${result.name} exceeded its ${runtime} p50 budget: ${result.p50.toFixed(1)}ms > ${budgetMs.toFixed(1)}ms`,
      );
    }
  }
}

export class RigBenchmarkSuiteClass {
  private readonly entrypoint = process.env.RIG_BENCH_ENTRY ?? "dist/bin.mjs";
  private readonly iterations = Number(process.env.RIG_BENCH_ITERATIONS ?? 20);
  private readonly runner = new RigBenchmarkRunnerClass(this.entrypoint, this.iterations);
  private readonly reporter = new BenchmarkReporterClass();

  async run(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "rig-bench-home-"));
    try {
      const environment = this.environment(home);
      this.runner.spawn(
        new BenchmarkCommandClass("setup", ["create", "sample"], environment),
        "bun",
      );
      await Promise.all([
        this.createNestedBenchmarkTools(home),
        this.createCollectionBenchmarkTool(home),
        this.createLoggingBenchmarkTool(home),
        this.createSearchBenchmarkTools(home),
      ]);

      const commands = this.commands(environment);
      console.log(`Entrypoint: ${this.entrypoint}`);
      console.log(`Iterations: ${this.iterations}`);
      await this.runtimes().reduce(async (previousRuntime, runtime) => {
        await previousRuntime;
        console.log(`\nRuntime: ${runtime}`);
        await commands.reduce(async (previousCommand, command) => {
          await previousCommand;
          this.reporter.print(
            await this.runner.run(command, runtime),
            runtime,
            command.p50BudgetMs[runtime],
          );
        }, Promise.resolve());
      }, Promise.resolve());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  private commands(environment: Record<string, string | undefined>): BenchmarkCommandClass[] {
    const searchToolCount = this.searchToolCount();
    const commands = [
      new BenchmarkCommandClass("config path", ["config", "path"], environment, {
        bun: 60,
        node: 130,
      }),
      new BenchmarkCommandClass(`list (${searchToolCount + 5} tools)`, ["list"], environment, {
        bun: 70 + searchToolCount * 0.25,
        node: 150 + searchToolCount * 0.3,
      }),
      new BenchmarkCommandClass(
        `find (${searchToolCount} tools)`,
        ["find", "resize local image width"],
        environment,
        { bun: 80 + searchToolCount * 0.3, node: 160 + searchToolCount * 0.4 },
      ),
      new BenchmarkCommandClass("help command", ["help", "sample.example"], environment, {
        bun: 90,
        node: 150,
      }),
      new BenchmarkCommandClass("run command", ["run", "sample.example", "Agent"], environment, {
        bun: 100,
        node: 180,
      }),
      new BenchmarkCommandClass(
        "nested run (50)",
        ["run", "caller.call", "--input", JSON.stringify({ count: 50 })],
        environment,
        { bun: 110, node: 190 },
      ),
      new BenchmarkCommandClass(
        "collection unused (1000)",
        ["run", "collection-bench.noop"],
        environment,
        { bun: 100, node: 180 },
      ),
      new BenchmarkCommandClass(
        "collection count (1000)",
        ["run", "collection-bench.count"],
        environment,
        { bun: 130, node: 230 },
      ),
      new BenchmarkCommandClass(
        "structured logs (1000)",
        ["run", "logging-bench.write", "1000"],
        { ...environment, RIG_LOG: "1" },
        { bun: 120, node: 200 },
      ),
    ];

    if (process.env.RIG_BENCH_TYPECHECK === "1") {
      commands.push(new BenchmarkCommandClass("typecheck", ["typecheck", "sample"], environment));
    }
    return commands;
  }

  private environment(home: string): Record<string, string | undefined> {
    return {
      RIG_HOME: home,
      RIG_AGENT_SYNC: "0",
      RIG_UPDATE_CHECK: "0",
      RIG_LOG: "0",
    };
  }

  private runtimes(): BenchmarkRuntime[] {
    const requested = (process.env.RIG_BENCH_RUNTIMES ?? "bun,node")
      .split(",")
      .map((runtime) => runtime.trim())
      .filter(Boolean);
    const invalid = requested.find((runtime) => runtime !== "bun" && runtime !== "node");
    if (invalid) throw new Error(`Unsupported benchmark runtime: ${invalid}`);
    return [...new Set(requested)] as BenchmarkRuntime[];
  }

  private searchToolCount(): number {
    return Number(process.env.RIG_BENCH_TOOLS ?? 100);
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

  private async createCollectionBenchmarkTool(home: string): Promise<void> {
    const toolDir = join(home, "rig", "tools", "collection-bench");
    await Bun.write(
      join(toolDir, "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  description: "Collection benchmark tool.",
  collections: { documents: {} },
  commands: {
    noop: rig.defineCommand({
      description: "Return without using collections.",
      input: rig.z.object({}),
      output: rig.z.number(),
      run: () => 1,
    }),
    count: rig.defineCommand({
      description: "Count collection entries.",
      input: rig.z.object({}),
      output: rig.z.number(),
      run: (context) => context.collections.documents.count(),
    }),
  },
});
`,
    );
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        Bun.write(
          join(toolDir, "documents", `${index}.md`),
          `---\nvalue: ${index}\n---\n\nBenchmark document ${index}.\n`,
        ),
      ),
    );
  }

  private async createLoggingBenchmarkTool(home: string): Promise<void> {
    await Bun.write(
      join(home, "rig", "tools", "logging-bench", "index.rig.ts"),
      `export default (rig) => rig.defineTool({
  description: "Logging benchmark tool.",
  commands: {
    write: rig.defineCommand({
      description: "Write structured log records.",
      input: rig.z.object({ count: rig.z.coerce.number() }),
      output: rig.z.number(),
      run: (context) => {
        for (let index = 0; index < context.input.count; index++) {
          context.log.info({ index }, "Benchmark log record.");
        }
        return context.input.count;
      },
    }),
  },
});
`,
    );
  }

  private async createSearchBenchmarkTools(home: string): Promise<void> {
    await Promise.all(
      Array.from({ length: this.searchToolCount() }, (_, index) => {
        const name = `search-${index}`;
        return Bun.write(
          join(home, "rig", "tools", name, "index.rig.ts"),
          `export default (rig) => rig.defineTool({
  description: "Resize, sharpen, and inspect local image documents.",
  commands: {
    convert: rig.defineCommand({
      description: "Convert image ${index} with width, quality, and output format options.",
      input: rig.z.object({
        input: rig.z.string().describe("Local image path"),
        width: rig.z.number().optional(),
        format: rig.z.string().optional(),
      }),
      output: rig.z.string(),
      run: (context) => context.input.input,
    }),
  },
});
`,
        );
      }),
    );
  }
}
