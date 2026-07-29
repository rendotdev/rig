import { Context, Effect, Layer, Predicate, Schema } from "effect";

export class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()("ReleaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

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

export class SemverVersion extends Schema.Class<SemverVersion>("SemverVersion")({
  major: Schema.Finite,
  minor: Schema.Finite,
  patch: Schema.Finite,
  prerelease: Schema.Array(Schema.String),
}) {}

export class ReleaseService extends Context.Service<
  ReleaseService,
  {
    readonly parseVersion: (value: string) => Effect.Effect<SemverVersion, ReleaseError>;
    readonly compareVersions: (left: SemverVersion, right: SemverVersion) => Effect.Effect<number>;
    readonly renderVersion: (version: SemverVersion) => Effect.Effect<string>;
    readonly nextVersion: (
      currentValue: string,
      bump: string,
    ) => Effect.Effect<string, ReleaseError>;
    readonly run: (args: string[]) => Effect.Effect<void, ReleaseError>;
  }
>()("@rendotdev/rig/scripts/ReleaseService", {
  make: Effect.gen(function* () {
    const failure = (message: string, cause?: unknown) => new ReleaseError({ message, cause });

    const parseOptions = (args: string[]): ReleaseOptions | "help" => {
      const options: ReleaseOptions = {
        bump: "patch",
        checks: true,
        dryRun: false,
        push: true,
        tag: true,
      };
      const positional: string[] = [];
      for (const arg of args) {
        const isHelpOption = arg === "--help" || arg === "-h";
        if (isHelpOption) return "help";
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--no-push") options.push = false;
        else if (arg === "--no-tag") options.tag = false;
        else if (arg === "--skip-checks") options.checks = false;
        else if (arg.startsWith("-")) throw failure(`Unknown release option: ${arg}`);
        else positional.push(arg);
      }
      if (positional.length > 1) {
        throw failure(`Expected one version bump, received: ${positional.join(", ")}`);
      }
      options.bump = positional[0] ?? options.bump;
      return options;
    };

    const usage = () =>
      [
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

    const parseVersionValue = (value: string): SemverVersion => {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
      if (!match) throw failure(`Version must use semver: ${value}`);
      const prerelease = match[4]?.split(".") ?? [];
      if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))) {
        throw failure(`Numeric prerelease identifiers cannot have leading zeroes: ${value}`);
      }
      return new SemverVersion({
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease,
      });
    };

    const compareVersionValues = (left: SemverVersion, right: SemverVersion): number => {
      if (left.major !== right.major) return left.major - right.major;
      if (left.minor !== right.minor) return left.minor - right.minor;
      if (left.patch !== right.patch) return left.patch - right.patch;
      if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
      if (right.prerelease.length === 0) return -1;
      const length = Math.max(left.prerelease.length, right.prerelease.length);
      for (let index = 0; index < length; index++) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        const hasNumericParts = leftNumeric && rightNumeric;
        if (hasNumericParts) return Number(leftPart) - Number(rightPart);
        if (leftNumeric) return -1;
        if (rightNumeric) return 1;
        return leftPart.localeCompare(rightPart);
      }
      return 0;
    };

    const renderVersionValue = (version: SemverVersion): string => {
      const core = `${version.major}.${version.minor}.${version.patch}`;
      return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core;
    };

    const bumpVersion = (version: SemverVersion, kind: string): SemverVersion => {
      if (kind === "major") {
        return new SemverVersion({ major: version.major + 1, minor: 0, patch: 0, prerelease: [] });
      }
      if (kind === "minor") {
        return new SemverVersion({
          major: version.major,
          minor: version.minor + 1,
          patch: 0,
          prerelease: [],
        });
      }
      if (kind === "patch") {
        return new SemverVersion({
          major: version.major,
          minor: version.minor,
          patch: version.prerelease.length > 0 ? version.patch : version.patch + 1,
          prerelease: [],
        });
      }
      if (kind === "beta") {
        if (version.prerelease[0] === "beta") {
          const sequence = Number(version.prerelease[1] ?? "0");
          return new SemverVersion({
            major: version.major,
            minor: version.minor,
            patch: version.patch,
            prerelease: ["beta", String(Number.isSafeInteger(sequence) ? sequence + 1 : 0)],
          });
        }
        return new SemverVersion({
          major: version.major,
          minor: version.minor,
          patch: version.patch + 1,
          prerelease: ["beta", "0"],
        });
      }
      throw failure(`Version bump must be beta, patch, minor, major, or explicit semver: ${kind}`);
    };

    const nextVersionValue = (currentValue: string, bump: string): string => {
      const current = parseVersionValue(currentValue);
      if (["beta", "major", "minor", "patch"].includes(bump)) {
        return renderVersionValue(bumpVersion(current, bump));
      }
      const explicit = parseVersionValue(bump);
      if (compareVersionValues(explicit, current) <= 0) {
        throw failure(
          `Next version must be greater than ${renderVersionValue(current)}: ${renderVersionValue(explicit)}`,
        );
      }
      return renderVersionValue(explicit);
    };

    const parseVersion = Effect.fn("ReleaseService.parseVersion")(function* (value: string) {
      return yield* Effect.try({
        try: () => parseVersionValue(value),
        catch: (cause) =>
          cause instanceof ReleaseError
            ? cause
            : failure(`Could not parse version: ${value}`, cause),
      });
    });

    const compareVersions = Effect.fn("ReleaseService.compareVersions")(function* (
      left: SemverVersion,
      right: SemverVersion,
    ) {
      return compareVersionValues(left, right);
    });

    const renderVersion = Effect.fn("ReleaseService.renderVersion")(function* (
      version: SemverVersion,
    ) {
      return renderVersionValue(version);
    });

    const nextVersion = Effect.fn("ReleaseService.nextVersion")(function* (
      currentValue: string,
      bump: string,
    ) {
      return yield* Effect.try({
        try: () => nextVersionValue(currentValue, bump),
        catch: (cause) =>
          cause instanceof ReleaseError
            ? cause
            : failure(`Could not resolve next version from ${currentValue}.`, cause),
      });
    });

    const renderCommand = (command: string[]) =>
      command.map((part) => (/\s|["']/.test(part) ? JSON.stringify(part) : part)).join(" ");

    const executeCommand = Effect.fn("ReleaseService.executeCommand")(function* (
      command: string[],
    ) {
      return yield* Effect.try({
        try: () => {
          console.log(`$ ${renderCommand(command)}`);
          const result = Bun.spawnSync({
            cmd: command,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
          });
          if (result.exitCode !== 0) {
            throw failure(
              `Command failed with exit code ${result.exitCode}: ${renderCommand(command)}`,
            );
          }
        },
        catch: (cause) =>
          cause instanceof ReleaseError
            ? cause
            : failure(`Command failed: ${renderCommand(command)}`, cause),
      });
    });

    const captureCommand = Effect.fn("ReleaseService.captureCommand")(function* (
      command: string[],
    ) {
      return yield* Effect.try({
        try: () => {
          const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
          if (result.exitCode !== 0) {
            throw failure(
              result.stderr.toString().trim() || `Command failed: ${renderCommand(command)}`,
            );
          }
          return result.stdout.toString().trim();
        },
        catch: (cause) =>
          cause instanceof ReleaseError
            ? cause
            : failure(`Command failed: ${renderCommand(command)}`, cause),
      });
    });

    const readManifest = Effect.tryPromise({
      try: async () => {
        const data = JSON.parse(await Bun.file("package.json").text()) as unknown;
        if (!Predicate.isObject(data)) throw failure("package.json must contain a JSON object.");
        return data as PackageManifest;
      },
      catch: (cause) =>
        cause instanceof ReleaseError ? cause : failure("Could not read package.json.", cause),
    }).pipe(Effect.withSpan("ReleaseService.readManifest"));

    const writeManifest = Effect.fn("ReleaseService.writeManifest")(function* (
      manifest: PackageManifest,
    ) {
      return yield* Effect.tryPromise({
        try: () =>
          Bun.write("package.json", `${JSON.stringify(manifest, null, 2)}\n`).then(() => undefined),
        catch: (cause) => failure("Could not write package.json.", cause),
      });
    });

    const ensureClean = Effect.gen(function* () {
      const status = yield* captureCommand(["git", "status", "--porcelain"]);
      if (status) return yield* failure("Release requires a clean git working tree.");
      return undefined;
    }).pipe(Effect.withSpan("ReleaseService.ensureClean"));

    const ensureTagMissing = Effect.fn("ReleaseService.ensureTagMissing")(function* (tag: string) {
      const existing = yield* captureCommand(["git", "tag", "--list", tag]);
      if (existing) return yield* failure(`Tag already exists: ${tag}`);
      return undefined;
    });

    const currentBranch = Effect.gen(function* () {
      const branch = yield* captureCommand(["git", "branch", "--show-current"]);
      if (!branch) return yield* failure("Could not determine the current git branch.");
      return branch;
    }).pipe(Effect.withSpan("ReleaseService.currentBranch"));

    const renderDryRunPlan = (options: ReleaseOptions, tagName: string): string => {
      if (!options.push) return "Would leave the release commit and tag local.";
      if (!options.tag) return "Would push the release commit without starting publish.yml.";
      return `Would push ${tagName}; GitHub Actions would run publish.yml from CI.`;
    };

    const renderCiStatus = (options: ReleaseOptions, tagName: string): string => {
      if (!options.push) return "Release commit and tag are local only.";
      if (!options.tag) return "Pushed the release commit without starting publish.yml.";
      return `Pushed ${tagName}; GitHub Actions will run publish.yml from CI.`;
    };

    const run = Effect.fn("ReleaseService.run")(function* (args: string[]) {
      const options = yield* Effect.try({
        try: () => parseOptions(args),
        catch: (cause) =>
          cause instanceof ReleaseError
            ? cause
            : failure("Could not parse release options.", cause),
      });
      if (options === "help") {
        yield* Effect.sync(() => console.log(usage()));
        return undefined;
      }
      const manifest = yield* readManifest;
      if (typeof manifest.version !== "string") {
        return yield* failure("package.json needs a version.");
      }
      const next = yield* Effect.try({
        try: () => nextVersionValue(manifest.version!, options.bump),
        catch: (cause) =>
          cause instanceof ReleaseError ? cause : failure("Could not resolve next version.", cause),
      });
      const tagName = `v${next}`;
      const packageName = manifest.name ?? "package";
      yield* Effect.sync(() =>
        console.log(`Release ${packageName}: ${manifest.version} -> ${next}`),
      );
      if (options.dryRun) {
        yield* Effect.sync(() =>
          console.log(`Dry run only. ${renderDryRunPlan(options, tagName)}`),
        );
        return undefined;
      }
      yield* ensureClean;
      if (options.tag) yield* ensureTagMissing(tagName);
      if (options.checks) yield* executeCommand(["vp", "run", "validate"]);
      manifest.version = next;
      yield* writeManifest(manifest);
      yield* executeCommand(["vp", "fmt", "package.json"]);
      yield* executeCommand(["git", "add", "package.json"]);
      yield* executeCommand(["git", "commit", "-m", `Release ${tagName}`]);
      if (options.tag) {
        yield* executeCommand(["git", "tag", "-a", tagName, "-m", `Release ${tagName}`]);
      }
      if (options.push) {
        yield* executeCommand(["git", "push", "origin", yield* currentBranch]);
        if (options.tag) yield* executeCommand(["git", "push", "origin", tagName]);
      }
      yield* Effect.sync(() =>
        console.log(`Release ${tagName} is ready. ${renderCiStatus(options, tagName)}`),
      );
      return undefined;
    });

    return { parseVersion, compareVersions, renderVersion, nextVersion, run } as const;
  }),
}) {
  static readonly layer = Layer.effect(ReleaseService, ReleaseService.make);
}
