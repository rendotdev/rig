import { describe, expect, it } from "vite-plus/test";
import { CollectionFieldPathCompilerClass } from "./collection-field-path";

describe("CollectionFieldPathCompilerClass", () => {
  const compiler = new CollectionFieldPathCompilerClass();

  it("compiles nested paths for SQLite and object traversal", () => {
    const path = compiler.compile("project.owner_id");

    expect(path.segments).toEqual(["project", "owner_id"]);
    expect(path.sqliteJsonPath).toBe("$.project.owner_id");
    expect(path.read({ project: { owner_id: "rene" } })).toBe("rene");
    expect(path.read({ project: null })).toBeUndefined();
    expect(path.read({ project: [] })).toBeUndefined();
  });

  it.each([
    "",
    ".status",
    "status.",
    "project..status",
    "0status",
    "project[0]",
    "status') OR 1=1 --",
    "status; DELETE FROM docs",
    "status value",
    "status/owner",
  ])("rejects malformed or injection-like paths: %s", (value) => {
    expect(() => compiler.compile(value)).toThrow("Invalid collection field path");
  });
});
