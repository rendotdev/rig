import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { HelpTopicsService, helpTopicsLayer } from "./help-topics";

const expectedTopics = [
  "collections",
  "kv",
  "cache",
  "db",
  "env",
  "log",
  "shell",
  "run",
  "tool",
  "args",
  "paths",
];

describe("help topics", () => {
  it("lists and renders topics", async () => {
    const service = await Effect.runPromise(
      HelpTopicsService.use(Effect.succeed).pipe(Effect.provide(helpTopicsLayer)),
    );
    expect(await Effect.runPromise(service.list)).toEqual(expectedTopics);
    expect(await Effect.runPromise(service.render("collections"))).toContain(
      "# Help • Collections",
    );
    expect(await Effect.runPromise(service.render("missing"))).toBeUndefined();
    expect(await Effect.runPromise(service.renderList)).toContain("Usage: `rig help <topic>`");
    expect(await Effect.runPromise(service.renderList)).toContain("  collections    Collections");
  });
});
