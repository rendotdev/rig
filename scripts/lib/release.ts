class ReleaseErrorClass extends Error {}

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

class ReleaseOptionsParserClass {
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
      else if (arg.startsWith("-")) throw new ReleaseErrorClass(`Unknown release option: ${arg}`);
      else positional.push(arg);
    }

    if (positional.length > 1) {
      throw new ReleaseErrorClass(`Expected one version bump, received: ${positional.join(", ")}`);
    }

    options.bump = positional[0] ?? options.bump;
    return options;
  }

  usage(): string {
    return [
      "Usage: vp run release -- [beta|patch|minor|major|x.y.z[-prerelease]] [options]",
      "",
      "By default this commits package.json, pushes an annotated vX tag, and lets GitHub Actions run publish.yml from CI. It never runs npm publish locally.",
      "",
      "Options:",
      "  --dry-run       Print the planned release without changing files.",
      "  --no-push       Commit and tag locally, but do not push or start CI.",
      "  --no-tag        Commit the version bump without creating a git tag or starting publish.yml.",
      "  --skip-checks   Skip vp run validate.",
      "",
      "Examples:",
      "  vp run release:beta",
      "  vp run release:patch",
      "  vp run release -- minor",
      "  vp run release -- 0.1.0-beta.0 --no-push",
    ].join("\n");
  }
}

export class SemverVersionClass {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
    readonly prerelease: readonly string[] = [],
  ) {}

  parse(value: string): SemverVersionClass {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    if (!match) {
      throw new ReleaseErrorClass(`Version must use semver: ${value}`);
    }
    const prerelease = match[4]?.split(".") ?? [];
    if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))) {
      throw new ReleaseErrorClass(
        `Numeric prerelease identifiers cannot have leading zeroes: ${value}`,
      );
    }
    return new SemverVersionClass(Number(match[1]), Number(match[2]), Number(match[3]), prerelease);
  }

  bump(kind: string): SemverVersionClass {
    if (kind === "major") return new SemverVersionClass(this.major + 1, 0, 0);
    if (kind === "minor") return new SemverVersionClass(this.major, this.minor + 1, 0);
    if (kind === "patch") {
      return this.prerelease.length > 0
        ? new SemverVersionClass(this.major, this.minor, this.patch)
        : new SemverVersionClass(this.major, this.minor, this.patch + 1);
    }
    if (kind === "beta") {
      if (this.prerelease[0] === "beta") {
        const sequence = Number(this.prerelease[1] ?? "0");
        return new SemverVersionClass(this.major, this.minor, this.patch, [
          "beta",
          String(Number.isSafeInteger(sequence) ? sequence + 1 : 0),
        ]);
      }
      return new SemverVersionClass(this.major, this.minor, this.patch + 1, ["beta", "0"]);
    }
    throw new ReleaseErrorClass(
      `Version bump must be beta, patch, minor, major, or explicit semver: ${kind}`,
    );
  }

  compare(other: SemverVersionClass): number {
    if (this.major !== other.major) return this.major - other.major;
    if (this.minor !== other.minor) return this.minor - other.minor;
    if (this.patch !== other.patch) return this.patch - other.patch;
    if (this.prerelease.length === 0) return other.prerelease.length === 0 ? 0 : 1;
    if (other.prerelease.length === 0) return -1;

    const length = Math.max(this.prerelease.length, other.prerelease.length);
    for (let index = 0; index < length; index++) {
      const left = this.prerelease[index];
      const right = other.prerelease[index];
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      if (left === right) continue;
      const leftNumeric = /^\d+$/.test(left);
      const rightNumeric = /^\d+$/.test(right);
      if (leftNumeric && rightNumeric) return Number(left) - Number(right);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return left.localeCompare(right);
    }
    return 0;
  }

  toString(): string {
    const core = `${this.major}.${this.minor}.${this.patch}`;
    return this.prerelease.length > 0 ? `${core}-${this.prerelease.join(".")}` : core;
  }
}

const semverVersions = new SemverVersionClass(0, 0, 0);

export class VersionBumpResolverClass {
  next(currentValue: string, bump: string): string {
    const current = semverVersions.parse(currentValue);
    if (["beta", "major", "minor", "patch"].includes(bump)) {
      return current.bump(bump).toString();
    }

    const explicit = semverVersions.parse(bump);
    if (explicit.compare(current) <= 0) {
      throw new ReleaseErrorClass(`Next version must be greater than ${current}: ${explicit}`);
    }
    return explicit.toString();
  }
}

class PackageManifestFileClass {
  constructor(private readonly path: string) {}

  async read(): Promise<PackageManifest> {
    const data = JSON.parse(await Bun.file(this.path).text());
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ReleaseErrorClass(`${this.path} must contain a JSON object.`);
    }
    return data as PackageManifest;
  }

  async write(manifest: PackageManifest): Promise<void> {
    await Bun.write(this.path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

class CommandRunnerClass {
  run(command: string[]): void {
    console.log(`$ ${this.render(command)}`);
    const result = Bun.spawnSync({
      cmd: command,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new ReleaseErrorClass(
        `Command failed with exit code ${result.exitCode}: ${this.render(command)}`,
      );
    }
  }

  capture(command: string[]): string {
    const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new ReleaseErrorClass(
        result.stderr.toString().trim() || `Command failed: ${this.render(command)}`,
      );
    }
    return result.stdout.toString().trim();
  }

  private render(command: string[]): string {
    return command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
  }
}

class GitReleaseRepositoryClass {
  constructor(private readonly runner: CommandRunnerClass) {}

  ensureClean(): void {
    const status = this.runner.capture(["git", "status", "--porcelain"]);
    if (status) throw new ReleaseErrorClass("Release requires a clean git working tree.");
  }

  ensureTagMissing(tag: string): void {
    const existing = this.runner.capture(["git", "tag", "--list", tag]);
    if (existing) throw new ReleaseErrorClass(`Tag already exists: ${tag}`);
  }

  currentBranch(): string {
    const branch = this.runner.capture(["git", "branch", "--show-current"]);
    if (!branch) throw new ReleaseErrorClass("Could not determine the current git branch.");
    return branch;
  }
}

class ReleaseCommandClass {
  private readonly optionsParser = new ReleaseOptionsParserClass();
  private readonly packageFile = new PackageManifestFileClass("package.json");
  private readonly runner = new CommandRunnerClass();
  private readonly repository = new GitReleaseRepositoryClass(this.runner);
  private readonly versions = new VersionBumpResolverClass();

  async run(args: string[]): Promise<void> {
    const options = this.optionsParser.parse(args);
    if (options === "help") {
      console.log(this.optionsParser.usage());
      return;
    }

    const manifest = await this.packageFile.read();
    if (typeof manifest.version !== "string")
      throw new ReleaseErrorClass("package.json needs a version.");
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
    this.runner.run(["vp", "fmt", "package.json"]);
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
    this.runner.run(["vp", "run", "validate"]);
  }

  private push(options: ReleaseOptions, tagName: string): void {
    this.runner.run(["git", "push", "origin", this.repository.currentBranch()]);
    if (options.tag) this.runner.run(["git", "push", "origin", tagName]);
  }
}

export class ReleaseEntrypointClass {
  run(): void {
    new ReleaseCommandClass().run(Bun.argv.slice(2)).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}
