import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

export class SmokeScriptError extends Schema.TaggedErrorClass<SmokeScriptError>()(
  "SmokeScriptError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class SmokeScriptService extends Context.Service<
  SmokeScriptService,
  {
    readonly run: Effect.Effect<void, SmokeScriptError>;
  }
>()("@rendotdev/rig/scripts/SmokeScriptService", {
  make: Effect.gen(function* () {
    const cliPath = join(import.meta.dir, "..", "..", "dist", "bin.mjs");

    const attempt = <Result>(operation: string, run: () => Promise<Result>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new SmokeScriptError({ operation, cause }),
      });

    const runRig = Effect.fn("SmokeScriptService.runRig")(function* (
      home: string,
      args: ReadonlyArray<string>,
      env: Readonly<Record<string, string>>,
    ) {
      return yield* attempt(`rig ${args.join(" ")}`, async () => {
        const process = Bun.spawn(["node", cliPath, ...args], {
          cwd: home,
          env: { ...globalThis.process.env, ...env },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(`Command failed: rig ${args.join(" ")}\n${stderr}\n${stdout}`);
        }
        return stdout;
      });
    });

    const run = Effect.acquireUseRelease(
      attempt("create smoke home", () => mkdtemp(join(tmpdir(), "rig-smoke-home-"))),
      (home) =>
        Effect.gen(function* () {
          const env = { HOME: home, RIG_HOME: home };
          yield* runRig(home, ["init"], env);
          yield* runRig(home, ["create", "sample"], env);
          yield* runRig(home, ["list"], env);
          yield* runRig(home, ["ls"], env);
          yield* runRig(home, ["help", "sample.example"], env);
          yield* runRig(home, ["inspect", "sample.example"], env);
          yield* runRig(home, ["run", "sample.example", "--dry-run", "smoke"], env);
          const stdout = yield* runRig(home, ["run", "sample.example", "smoke"], env);
          const parsed = yield* Effect.try({
            try: () => JSON.parse(stdout) as { errors?: unknown[]; data?: { text?: string } },
            catch: (cause) => new SmokeScriptError({ operation: "parse smoke output", cause }),
          });
          const hasUnexpectedOutput = parsed.errors?.length !== 0 || parsed.data?.text !== "smoke";
          if (hasUnexpectedOutput) {
            return yield* new SmokeScriptError({
              operation: "validate smoke output",
              cause: new Error(`Unexpected smoke output: ${stdout}`),
            });
          }
          yield* Effect.sync(() => console.log("Smoke OK"));
          return undefined;
        }),
      (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
    ).pipe(Effect.withSpan("SmokeScriptService.run"));

    return { run } as const;
  }),
}) {
  static readonly layer = Layer.effect(SmokeScriptService, SmokeScriptService.make);
}
