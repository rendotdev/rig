import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class SmokeScript {
  private home = "";

  async run(): Promise<void> {
    this.home = await mkdtemp(join(tmpdir(), "rig-smoke-home-"));
    try {
      const env = { RIG_HOME: this.home };
      await this.rig(["init"], env);
      await this.rig(["tool", "create", "hello"], env);
      await this.rig(["tool", "help", "hello", "greet"], env);
      const stdout = await this.rig(["run", "hello", "greet", "--input", '{"name":"world"}'], env);
      const parsed = JSON.parse(stdout);
      if (!parsed.extensions?.rig?.ok || parsed.extensions?.rig?.id !== "hello.greet") {
        throw new Error(`Unexpected smoke output: ${stdout}`);
      }
      console.log("Smoke OK");
    } finally {
      await rm(this.home, { recursive: true, force: true });
    }
  }

  private async rig(args: string[], env: Record<string, string>): Promise<string> {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Command failed: rig ${args.join(" ")}\n${stderr}\n${stdout}`);
    }
    return stdout;
  }
}

await new SmokeScript().run();
