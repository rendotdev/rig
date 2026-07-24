import { describe, expect, it } from "vite-plus/test";
import { helpTopicService, HelpTopicServiceClass, HelpTopicSingleton } from "./help-topics";

const ExpectedTopics = [
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
  it("lists, recognizes, and renders topics", () => {
    const Topics = HelpTopicSingleton;

    expect(Topics.listTopics({})).toEqual(ExpectedTopics);
    expect(Topics.isKnownTopic({ name: "collections" })).toBe(true);
    expect(Topics.isKnownTopic({ name: "missing" })).toBe(false);
    expect(Topics.render({ name: "collections" })).toContain("# Help • Collections");
    expect(Topics.render({ name: "missing" })).toBeUndefined();
    expect(Topics.renderTopicList({})).toContain("Usage: `rig help <topic>`");
    expect(Topics.renderTopicList({})).toContain("  collections    Collections");
  });

  it("preserves production and positional compatibility values", () => {
    const adapter = new HelpTopicServiceClass();

    expect(adapter).toBeInstanceOf(HelpTopicServiceClass);
    expect(adapter.listTopics()).toEqual(HelpTopicSingleton.listTopics({}));
    expect(adapter.isKnownTopic("kv")).toBe(true);
    expect(adapter.render("kv")).toContain("# Help • Key-Value State");
    expect(adapter.renderTopicList()).toBe(helpTopicService.renderTopicList());
  });
});
