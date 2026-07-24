import { describe, expect, it } from "vite-plus/test";
import {
  CollectionFieldPathCompilerClass,
  CollectionFieldPathSingleton,
} from "./collection-field-path";

describe("collection field paths", () => {
  const Compiler = CollectionFieldPathSingleton;

  it("compiles nested paths for SQLite and object traversal", () => {
    const path = Compiler.compile({ value: "project.owner_id" });

    expect(path.segments).toEqual(["project", "owner_id"]);
    expect(path.sqliteJsonPath).toBe("$.project.owner_id");
    expect(path.read({ project: { owner_id: "rene" } })).toBe("rene");
    expect(path.read({ project: null })).toBeUndefined();
    expect(path.read({ project: [] })).toBeUndefined();
    expect(CollectionFieldPathSingleton.compile({ value: "status" }).segments).toEqual(["status"]);

    const adapter = new CollectionFieldPathCompilerClass();
    expect(adapter).toBeInstanceOf(CollectionFieldPathCompilerClass);
    expect(adapter.compile("project.owner_id")).toMatchObject({
      segments: ["project", "owner_id"],
      sqliteJsonPath: "$.project.owner_id",
    });
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
    expect(() => Compiler.compile({ value })).toThrow("Invalid collection field path");
  });
});
