import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

const BenchmarkRuntime = Schema.Literals(["bun", "node"]);
type BenchmarkRuntime = typeof BenchmarkRuntime.Type;

export class BenchmarkError extends Schema.TaggedErrorClass<BenchmarkError>()("BenchmarkError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

class BenchmarkCommand extends Schema.Class<BenchmarkCommand>("BenchmarkCommand")({
  name: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined])),
  p50BudgetMs: Schema.Record(Schema.String, Schema.Finite),
}) {}

type BenchmarkResult = {
  name: string;
  min: number;
  p50: number;
  p95: number;
  mean: number;
};

export class RigBenchmarkService extends Context.Service<
  RigBenchmarkService,
  {
    readonly run: Effect.Effect<void, BenchmarkError>;
  }
>()("@rendotdev/rig/scripts/RigBenchmarkService", {
  make: Effect.gen(function* () {
    const entrypoint = process.env.RIG_BENCH_ENTRY ?? "dist/bin.mjs";
    const iterations = Number(process.env.RIG_BENCH_ITERATIONS ?? 20);
    const warmups = 3;

    const attempt = <Result>(operation: string, run: () => Promise<Result>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new BenchmarkError({ operation, cause }),
      });

    const makeCommand = (
      name: string,
      args: string[],
      env: Record<string, string | undefined> = {},
      p50BudgetMs: Partial<Record<BenchmarkRuntime, number>> = {},
    ) => new BenchmarkCommand({ name, args, env, p50BudgetMs });

    const spawn = Effect.fn("RigBenchmarkService.spawn")(function* (
      command: BenchmarkCommand,
      runtime: BenchmarkRuntime,
    ) {
      return yield* Effect.try({
        try: () => {
          const executable = runtime === "bun" ? process.execPath : "node";
          const result = Bun.spawnSync({
            cmd: [executable, entrypoint, ...command.args],
            env: { ...process.env, ...command.env },
            stdout: "pipe",
            stderr: "pipe",
          });
          if (result.exitCode !== 0) {
            throw new Error(`${command.name} failed under ${runtime}: ${result.stderr.toString()}`);
          }
        },
        catch: (cause) => new BenchmarkError({ operation: `run ${command.name}`, cause }),
      });
    });

    const benchmark = Effect.fn("RigBenchmarkService.benchmark")(function* (
      command: BenchmarkCommand,
      runtime: BenchmarkRuntime,
    ) {
      for (let index = 0; index < warmups; index++) yield* spawn(command, runtime);
      const times: number[] = [];
      for (let index = 0; index < iterations; index++) {
        const started = performance.now();
        yield* spawn(command, runtime);
        times.push(performance.now() - started);
      }
      times.sort((left, right) => left - right);
      return {
        name: command.name,
        min: times[0] ?? 0,
        p50: times[Math.floor(times.length * 0.5)] ?? 0,
        p95: times[Math.floor(times.length * 0.95)] ?? 0,
        mean: times.reduce((total, value) => total + value, 0) / times.length,
      } satisfies BenchmarkResult;
    });

    const report = Effect.fn("RigBenchmarkService.report")(function* (
      result: BenchmarkResult,
      runtime: BenchmarkRuntime,
      budgetMs?: number,
    ) {
      return yield* Effect.try({
        try: () => {
          const budget = budgetMs === undefined ? "" : ` budget=${budgetMs.toFixed(0)}ms`;
          console.log(
            `${result.name.padEnd(28)} min=${result.min.toFixed(1)}ms p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms mean=${result.mean.toFixed(1)}ms${budget}`,
          );
          const exceedsEnforcedBudget =
            budgetMs !== undefined &&
            result.p50 > budgetMs &&
            process.env.RIG_BENCH_ENFORCE !== "0";
          if (exceedsEnforcedBudget) {
            throw new Error(
              `${result.name} exceeded its ${runtime} p50 budget: ${result.p50.toFixed(1)}ms > ${budgetMs.toFixed(1)}ms`,
            );
          }
        },
        catch: (cause) => new BenchmarkError({ operation: `report ${result.name}`, cause }),
      });
    });

    const environment = (home: string): Record<string, string | undefined> => ({
      RIG_HOME: home,
      RIG_AGENT_SYNC: "0",
      RIG_UPDATE_CHECK: "0",
      RIG_LOG: "0",
    });

    const searchToolCount = () => Number(process.env.RIG_BENCH_TOOLS ?? 100);

    const runtimes = (): BenchmarkRuntime[] => {
      const requested = (process.env.RIG_BENCH_RUNTIMES ?? "bun,node")
        .split(",")
        .map((runtime) => runtime.trim())
        .filter(Boolean);
      const invalid = requested.find((runtime) => runtime !== "bun" && runtime !== "node");
      if (invalid) throw new Error(`Unsupported benchmark runtime: ${invalid}`);
      return [...new Set(requested)] as BenchmarkRuntime[];
    };

    const commands = (env: Record<string, string | undefined>): BenchmarkCommand[] => {
      const toolCount = searchToolCount();
      const values = [
        makeCommand("config path", ["config", "path"], env, { bun: 60, node: 130 }),
        makeCommand(`list (${toolCount + 5} tools)`, ["list"], env, {
          bun: 70 + toolCount * 0.25,
          node: 150 + toolCount * 0.3,
        }),
        makeCommand(`find (${toolCount} tools)`, ["find", "resize local image width"], env, {
          bun: 80 + toolCount * 0.3,
          node: 160 + toolCount * 0.4,
        }),
        makeCommand("help command", ["help", "sample.example"], env, { bun: 90, node: 150 }),
        makeCommand("run command", ["run", "sample.example", "Agent"], env, {
          bun: 100,
          node: 180,
        }),
        makeCommand(
          "nested run (50)",
          ["run", "caller.call", "--input", JSON.stringify({ count: 50 })],
          env,
          { bun: 110, node: 190 },
        ),
        makeCommand("collection unused (1000)", ["run", "collection-bench.noop"], env, {
          bun: 100,
          node: 180,
        }),
        makeCommand("collection count (1000)", ["run", "collection-bench.count"], env, {
          bun: 130,
          node: 230,
        }),
        makeCommand(
          "structured logs (1000)",
          ["run", "logging-bench.write", "1000"],
          { ...env, RIG_LOG: "1" },
          { bun: 120, node: 200 },
        ),
      ];
      if (process.env.RIG_BENCH_TYPECHECK === "1") {
        values.push(makeCommand("typecheck", ["typecheck", "sample"], env));
      }
      return values;
    };

    const writeTool = Effect.fn("RigBenchmarkService.writeTool")(function* (
      path: string,
      source: string,
    ) {
      return yield* attempt(`write ${path}`, () => Bun.write(path, source));
    });

    const createNestedTools = Effect.fn("RigBenchmarkService.createNestedTools")(function* (
      home: string,
    ) {
      const toolsDir = join(home, "rig", "tools");
      const calleeDir = join(toolsDir, "callee");
      const callerDir = join(toolsDir, "caller");
      yield* attempt("create nested tool directories", () =>
        Promise.all([
          mkdir(calleeDir, { recursive: true }),
          mkdir(callerDir, { recursive: true }),
        ]).then(() => undefined),
      );
      yield* Effect.all([
        writeTool(
          join(calleeDir, "index.rig.ts"),
          `export default (rig) => rig.defineTool({
  description: "Nested benchmark callee.",
  commands: { read: rig.defineCommand({ description: "Return one.", input: rig.z.object({}), output: rig.z.number(), run: () => 1 }) },
});
`,
        ),
        writeTool(
          join(callerDir, "index.rig.ts"),
          `export default (rig) => rig.defineTool({
  description: "Nested benchmark caller.",
  commands: { call: rig.defineCommand({
    description: "Call another tool repeatedly.", input: rig.z.object({ count: rig.z.number() }), output: rig.z.array(rig.z.number()),
    run: async (context) => { const values = []; for (let index = 0; index < context.input.count; index++) values.push(await context.rig.run({ command: "callee.read" })); return values; },
  }) },
});
`,
        ),
      ]);
    });

    const createCollectionTool = Effect.fn("RigBenchmarkService.createCollectionTool")(function* (
      home: string,
    ) {
      const toolDir = join(home, "rig", "tools", "collection-bench");
      yield* writeTool(
        join(toolDir, "index.rig.ts"),
        `export default (rig) => rig.defineTool({
  description: "Collection benchmark tool.", collections: { documents: {} },
  commands: {
    noop: rig.defineCommand({ description: "Return without using collections.", input: rig.z.object({}), output: rig.z.number(), run: () => 1 }),
    count: rig.defineCommand({ description: "Count collection entries.", input: rig.z.object({}), output: rig.z.number(), run: (context) => context.collections.documents.count() }),
  },
});
`,
      );
      yield* Effect.all(
        Array.from({ length: 1_000 }, (_, index) =>
          writeTool(
            join(toolDir, "documents", `${index}.md`),
            `---\nvalue: ${index}\n---\n\nBenchmark document ${index}.\n`,
          ),
        ),
        { concurrency: "unbounded" },
      );
    });

    const createLoggingTool = Effect.fn("RigBenchmarkService.createLoggingTool")(function* (
      home: string,
    ) {
      return yield* writeTool(
        join(home, "rig", "tools", "logging-bench", "index.rig.ts"),
        `export default (rig) => rig.defineTool({
  description: "Logging benchmark tool.",
  commands: { write: rig.defineCommand({
    description: "Write structured log records.", input: rig.z.object({ count: rig.z.coerce.number() }), output: rig.z.number(),
    run: (context) => { for (let index = 0; index < context.input.count; index++) context.log.info({ index }, "Benchmark log record."); return context.input.count; },
  }) },
});
`,
      );
    });

    const createSearchTools = Effect.fn("RigBenchmarkService.createSearchTools")(function* (
      home: string,
    ) {
      yield* Effect.all(
        Array.from({ length: searchToolCount() }, (_, index) => {
          const name = `search-${index}`;
          return writeTool(
            join(home, "rig", "tools", name, "index.rig.ts"),
            `export default (rig) => rig.defineTool({
  description: "Resize, sharpen, and inspect local image documents.",
  commands: { convert: rig.defineCommand({
    description: "Convert image ${index} with width, quality, and output format options.",
    input: rig.z.object({ input: rig.z.string().describe("Local image path"), width: rig.z.number().optional(), format: rig.z.string().optional() }),
    output: rig.z.string(), run: (context) => context.input.input,
  }) },
});
`,
          );
        }),
        { concurrency: "unbounded" },
      );
    });

    const run = Effect.acquireUseRelease(
      attempt("create benchmark home", () => mkdtemp(join(tmpdir(), "rig-bench-home-"))),
      (home) =>
        Effect.gen(function* () {
          const env = environment(home);
          yield* spawn(makeCommand("setup", ["create", "sample"], env), "bun");
          yield* Effect.all([
            createNestedTools(home),
            createCollectionTool(home),
            createLoggingTool(home),
            createSearchTools(home),
          ]);
          const commandList = commands(env);
          yield* Effect.sync(() => {
            console.log(`Entrypoint: ${entrypoint}`);
            console.log(`Iterations: ${iterations}`);
          });
          for (const runtime of runtimes()) {
            yield* Effect.sync(() => console.log(`\nRuntime: ${runtime}`));
            for (const command of commandList) {
              yield* report(
                yield* benchmark(command, runtime),
                runtime,
                command.p50BudgetMs[runtime],
              );
            }
          }
        }),
      (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
    ).pipe(Effect.withSpan("RigBenchmarkService.run"));

    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(RigBenchmarkService, RigBenchmarkService.make);
}
