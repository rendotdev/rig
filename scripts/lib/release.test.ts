import { describe, expect, test } from "vite-plus/test";
import { SemverVersionClass, VersionBumpResolverClass } from "./release";

describe("release versions", () => {
  const versions = new SemverVersionClass(0, 0, 0);
  const bumps = new VersionBumpResolverClass();

  test("parses and orders stable and prerelease versions", () => {
    expect(versions.parse("0.0.37-beta.0").toString()).toBe("0.0.37-beta.0");
    expect(
      versions.parse("0.0.37-beta.1").compare(versions.parse("0.0.37-beta.0")),
    ).toBeGreaterThan(0);
    expect(versions.parse("0.0.37").compare(versions.parse("0.0.37-beta.9"))).toBeGreaterThan(0);
    expect(versions.parse("0.0.37-beta.0").compare(versions.parse("0.0.36"))).toBeGreaterThan(0);
  });

  test("bumps stable and repeated beta versions", () => {
    expect(bumps.next("0.0.36", "beta")).toBe("0.0.37-beta.0");
    expect(bumps.next("0.0.37-beta.0", "beta")).toBe("0.0.37-beta.1");
    expect(bumps.next("0.0.37-beta.1", "patch")).toBe("0.0.37");
  });

  test("accepts increasing explicit prereleases and rejects invalid versions", () => {
    expect(bumps.next("0.0.36", "0.0.37-beta.0")).toBe("0.0.37-beta.0");
    expect(() => bumps.next("0.0.37-beta.1", "0.0.37-beta.0")).toThrow(
      "Next version must be greater",
    );
    expect(() => versions.parse("0.0.37-beta.01")).toThrow("leading zeroes");
  });
});
