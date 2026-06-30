class ReleaseError extends Error {}

type ReleaseOptions = {
  bump: string;
  checks: boolean;
  dryRun: boolean;
  push: boolean;
  tag: boolean;
};

type PackageManifest = {
  name?: string;
  version?: string;
  [key: string]: unknown;
};

class ReleaseOptionsParser {
  parse(args: string[]): ReleaseOptions | "help" {
    const options: ReleaseOptions = {
      bump: "patch",
      checks: true,
      dryRun: false,
      push: true,
      tag: true,
    };
    const positional: string[] = [];

    for (const arg of args) {
      if (arg === "--help" || arg === "-h") return "help";
      if (arg === "--dry-run") options.dryRun = true;
      else if (arg === "--no-push") options.push = false;
      else if (arg === "--no-tag") options.tag = false;
      else if (arg === "--skip-checks") options.checks = false;
      else if (arg.startsWith("-")) throw new ReleaseError(`Unknown release option: ${arg}`);
      else positional.push(arg);
    }

    if (positional.length > 1) {
      throw new ReleaseError(`Expected one version bump, received: ${positional.join(", ")}`);
    }

    options.bump = positional[0] ?? options.bump;
    return options;
  }

  usage(): string {
    return [
      "Usage: npm run release -- [patch|minor|major|x.y.z] [options]",
      "",
      "By default this commits package.json, pushes an annotated vX tag, and lets GitHub Actions run publish.yml from CI. It never runs npm publish locally.",
      "",
      "Options:",
      "  --dry-run       Print the planned release without changing files.",
      "  --no-push       Commit and tag locally, but do not push or start CI.",
      "  --no-tag        Commit the version bump without creating a git tag or starting publish.yml.",
      "  --skip-checks   Skip bun run test and bun run build.",
      "",
      "Examples:",
      "  npm run release:patch",
      "  npm run release -- minor",
      "  npm run release -- 0.1.0 --no-push",
    ].join("\n");
  }
}

class SemverVersion {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
  ) {}

  static parse(value: string): SemverVersion {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new ReleaseError(`Version must use x.y.z semver: ${value}`);
    return new SemverVersion(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  bump(kind: string): SemverVersion {
    if (kind === "major") return new SemverVersion(this.major + 1, 0, 0);
    if (kind === "minor") return new SemverVersion(this.major, this.minor + 1, 0);
    if (kind === "patch") return new SemverVersion(this.major, this.minor, this.patch + 1);
    throw new ReleaseError(`Version bump must be patch, minor, major, or x.y.z: ${kind}`);
  }

  compare(other: SemverVersion): number {
    if (this.major !== other.major) return this.major - other.major;
    if (this.minor !== other.minor) return this.minor - other.minor;
    return this.patch - other.patch;
  }

  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}

class VersionBumpResolver {
  next(currentValue: string, bump: string): string {
    const current = SemverVersion.parse(currentValue);
    if (["major", "minor", "patch"].includes(bump)) return current.bump(bump).toString();

    const explicit = SemverVersion.parse(bump);
    if (explicit.compare(current) <= 0) {
      throw new ReleaseError(`Next version must be greater than ${current}: ${explicit}`);
    }
    return explicit.toString();
  }
}

class PackageManifestFile {
  constructor(private readonly path: string) {}

  async read(): Promise<PackageManifest> {
    const data = JSON.parse(await Bun.file(this.path).text());
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ReleaseError(`${this.path} must contain a JSON object.`);
    }
    return data as PackageManifest;
  }

  async write(manifest: PackageManifest): Promise<void> {
    await Bun.write(this.path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

class CommandRunner {
  run(command: string[]): void {
    console.log(`$ ${this.render(command)}`);
    const result = Bun.spawnSync({
      cmd: command,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new ReleaseError(
        `Command failed with exit code ${result.exitCode}: ${this.render(command)}`,
      );
    }
  }

  capture(command: string[]): string {
    const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new ReleaseError(
        result.stderr.toString().trim() || `Command failed: ${this.render(command)}`,
      );
    }
    return result.stdout.toString().trim();
  }

  private render(command: string[]): string {
    return command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
  }
}

class GitReleaseRepository {
  constructor(private readonly runner: CommandRunner) {}

  ensureClean(): void {
    const status = this.runner.capture(["git", "status", "--porcelain"]);
    if (status) throw new ReleaseError("Release requires a clean git working tree.");
  }

  ensureTagMissing(tag: string): void {
    const existing = this.runner.capture(["git", "tag", "--list", tag]);
    if (existing) throw new ReleaseError(`Tag already exists: ${tag}`);
  }

  currentBranch(): string {
    const branch = this.runner.capture(["git", "branch", "--show-current"]);
    if (!branch) throw new ReleaseError("Could not determine the current git branch.");
    return branch;
  }
}

class ReleaseCommand {
  private readonly optionsParser = new ReleaseOptionsParser();
  private readonly packageFile = new PackageManifestFile("package.json");
  private readonly runner = new CommandRunner();
  private readonly repository = new GitReleaseRepository(this.runner);
  private readonly versions = new VersionBumpResolver();

  async run(args: string[]): Promise<void> {
    const options = this.optionsParser.parse(args);
    if (options === "help") {
      console.log(this.optionsParser.usage());
      return;
    }

    const manifest = await this.packageFile.read();
    if (typeof manifest.version !== "string")
      throw new ReleaseError("package.json needs a version.");
    const nextVersion = this.versions.next(manifest.version, options.bump);
    const tagName = `v${nextVersion}`;
    const packageName = manifest.name ?? "package";

    console.log(`Release ${packageName}: ${manifest.version} -> ${nextVersion}`);
    if (options.dryRun) {
      console.log(`Dry run only. ${this.renderDryRunPlan(options, tagName)}`);
      return;
    }

    this.repository.ensureClean();
    if (options.tag) this.repository.ensureTagMissing(tagName);
    if (options.checks) this.runChecks();

    manifest.version = nextVersion;
    await this.packageFile.write(manifest);
    this.runner.run(["bunx", "oxfmt", "package.json"]);
    this.runner.run(["git", "add", "package.json"]);
    this.runner.run(["git", "commit", "-m", `Release ${tagName}`]);

    if (options.tag) this.runner.run(["git", "tag", "-a", tagName, "-m", `Release ${tagName}`]);
    if (options.push) this.push(options, tagName);

    console.log(`Release ${tagName} is ready. ${this.renderCiStatus(options, tagName)}`);
  }

  private renderDryRunPlan(options: ReleaseOptions, tagName: string): string {
    if (!options.push) return "Would leave the release commit and tag local.";
    if (!options.tag) return "Would push the release commit without starting publish.yml.";
    return `Would push ${tagName}; GitHub Actions would run publish.yml from CI.`;
  }

  private renderCiStatus(options: ReleaseOptions, tagName: string): string {
    if (!options.push) return "Release commit and tag are local only.";
    if (!options.tag) return "Pushed the release commit without starting publish.yml.";
    return `Pushed ${tagName}; GitHub Actions will run publish.yml from CI.`;
  }

  private runChecks(): void {
    this.runner.run(["bun", "run", "test"]);
    this.runner.run(["bun", "run", "build"]);
  }

  private push(options: ReleaseOptions, tagName: string): void {
    this.runner.run(["git", "push", "origin", this.repository.currentBranch()]);
    if (options.tag) this.runner.run(["git", "push", "origin", tagName]);
  }
}

class ReleaseEntrypoint {
  run(): void {
    new ReleaseCommand().run(Bun.argv.slice(2)).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}

new ReleaseEntrypoint().run();
