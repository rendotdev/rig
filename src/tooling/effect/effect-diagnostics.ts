class EffectDiagnosticsClass {
  async run(): Promise<void> {
    const executable = (await this.capture(["bunx", "@effect/tsgo", "get-exe-path"])).trim();
    if (!executable) throw new Error("@effect/tsgo did not report its diagnostics executable.");
    if (process.platform !== "win32") await this.execute(["chmod", "+x", executable]);
    await this.execute([
      "bunx",
      "@effect/tsgo",
      "diagnostics",
      "--project",
      "tsconfig.json",
      "--format",
      "pretty",
      "--strict",
    ]);
  }

  private async capture(command: string[]): Promise<string> {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr || `${command[0]} exited with ${exitCode}.`);
    return stdout;
  }

  private async execute(command: string[]): Promise<void> {
    const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}.`);
  }
}

export const effectDiagnostics = await new EffectDiagnosticsClass().run();
