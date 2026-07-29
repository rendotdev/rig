import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { ReleaseService } from "./release";

const runRelease = <Result, Failure>(
  use: (service: ReleaseService["Service"]) => Effect.Effect<Result, Failure>,
): Result =>
  Effect.runSync(ReleaseService.use(use).pipe(Effect.provide(ReleaseService.layer), Effect.orDie));

describe("release versions", () => {
  test("parses and orders stable and prerelease versions", () => {
    runRelease((versions) =>
      Effect.gen(function* () {
        const beta0 = yield* versions.parseVersion("0.0.37-beta.0");
        const beta1 = yield* versions.parseVersion("0.0.37-beta.1");
        const stable = yield* versions.parseVersion("0.0.37");
        const previous = yield* versions.parseVersion("0.0.36");
        expect(yield* versions.renderVersion(beta0)).toBe("0.0.37-beta.0");
        expect(yield* versions.compareVersions(beta1, beta0)).toBeGreaterThan(0);
        expect(
          yield* versions.compareVersions(stable, yield* versions.parseVersion("0.0.37-beta.9")),
        ).toBeGreaterThan(0);
        expect(yield* versions.compareVersions(beta0, previous)).toBeGreaterThan(0);
      }),
    );
  });

  test("bumps stable and repeated beta versions", () => {
    runRelease((versions) =>
      Effect.gen(function* () {
        expect(yield* versions.nextVersion("0.0.36", "beta")).toBe("0.0.37-beta.0");
        expect(yield* versions.nextVersion("0.0.37-beta.0", "beta")).toBe("0.0.37-beta.1");
        expect(yield* versions.nextVersion("0.0.37-beta.1", "patch")).toBe("0.0.37");
      }),
    );
  });

  test("accepts increasing explicit prereleases and rejects invalid versions", () => {
    const next = runRelease((versions) => versions.nextVersion("0.0.36", "0.0.37-beta.0"));
    expect(next).toBe("0.0.37-beta.0");

    const invalidNext = Effect.runSync(
      ReleaseService.use((versions) =>
        Effect.flip(versions.nextVersion("0.0.37-beta.1", "0.0.37-beta.0")),
      ).pipe(Effect.provide(ReleaseService.layer)),
    );
    expect(invalidNext.message).toContain("Next version must be greater");

    const invalidVersion = Effect.runSync(
      ReleaseService.use((versions) => Effect.flip(versions.parseVersion("0.0.37-beta.01"))).pipe(
        Effect.provide(ReleaseService.layer),
      ),
    );
    expect(invalidVersion.message).toContain("leading zeroes");
  });
});
