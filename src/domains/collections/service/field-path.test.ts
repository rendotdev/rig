import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { CollectionFieldPathService } from "./field-path";

describe("collection field paths", () => {
  const compile = (value: string) =>
    Effect.runSync(
      CollectionFieldPathService.use((service) => service.compile(value)).pipe(
        Effect.provide(CollectionFieldPathService.layer),
      ),
    );

  it("compiles nested paths for SQLite and object traversal", () => {
    const path = compile("project.owner_id");

    expect(path.segments).toEqual(["project", "owner_id"]);
    expect(path.sqliteJsonPath).toBe("$.project.owner_id");
    expect(path.read({ project: { owner_id: "rene" } })).toBe("rene");
    expect(path.read({ project: null })).toBeUndefined();
    expect(path.read({ project: [] })).toBeUndefined();
    expect(compile("status").segments).toEqual(["status"]);
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
    expect(() => compile(value)).toThrow("Invalid collection field path");
  });
});
