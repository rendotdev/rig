import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

class RigBuildReporterClass {
  print(outputs: readonly unknown[]): void {
    console.log(`Built ${outputs.length} files in dist/.`);
  }

  printErrors(logs: readonly { message: string }[]): void {
    for (const log of logs) console.error(log.message);
  }
}

export class RigBuilderClass {
  private readonly reporter = new RigBuildReporterClass();

  async run(): Promise<void> {
    await rm("dist", { recursive: true, force: true });
    const result = await Bun.build({
      entrypoints: ["./src/cli.ts"],
      outdir: "./dist",
      target: "node",
      splitting: true,
      external: ["typescript"],
      naming: {
        entry: "rig.js",
        chunk: "[name]-[hash].js",
        asset: "[name]-[hash].[ext]",
      },
    });

    if (!result.success) {
      this.reporter.printErrors(result.logs);
      process.exit(1);
    }

    await chmod(join("dist", "rig.js"), 0o755);
    this.reporter.print(result.outputs);
  }
}
