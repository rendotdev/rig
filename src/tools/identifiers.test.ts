import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RigPathsClass } from "../config/paths";
import { ToolCreatorClass } from "./create";
import {
  collectionNames,
  CollectionNameClass,
  CollectionNameSingleton,
  commandNames,
  CommandNameClass,
  CommandNameSingleton,
  commandTargets,
  CommandTargetClass,
  CommandTargetSingleton,
  toolNames,
  ToolNameClass,
  ToolNameSingleton,
} from "./identifiers";
import { commandIds, CommandIdsClass, CommandIdsSingleton } from "./types";

describe("routed identifiers", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("builds routed identifier and command id behavior", () => {
    const ToolNames = ToolNameSingleton;
    const CommandNames = CommandNameSingleton;
    const CollectionNames = CollectionNameSingleton;
    const CommandTargets = CommandTargetSingleton;
    const CommandIds = CommandIdsSingleton;

    expect(ToolNames.create({ value: "clean-image-metadata" })).toEqual({
      value: "clean-image-metadata",
    });
    expect(ToolNames.parse({ value: "tool_2" })).toEqual({ value: "tool_2" });
    expect(CommandNames.create({ value: "get-status" })).toEqual({ value: "get-status" });
    expect(CommandNames.parse({ value: "get_status" })).toEqual({ value: "get_status" });
    expect(CollectionNames.parse({ value: "release-notes" })).toEqual({
      value: "release-notes",
    });
    expect(CommandTargets.create({ tool: "../raw", command: "nested.command" })).toEqual({
      tool: "../raw",
      command: "nested.command",
      id: "../raw.nested.command",
    });
    expect(CommandTargets.from({ tool: "clean-image-metadata", command: "get_metadata" })).toEqual({
      tool: "clean-image-metadata",
      command: "get_metadata",
      id: "clean-image-metadata.get_metadata",
    });
    expect(CommandTargets.parse({ id: "socials.post-message" })).toEqual({
      tool: "socials",
      command: "post-message",
      id: "socials.post-message",
    });
    expect(CommandIds.from({ tool: "clean-image-metadata", command: "get_metadata" })).toBe(
      "clean-image-metadata.get_metadata",
    );
    expect(() => CommandTargets.from({ tool: "../tool", command: "run" })).toThrow(
      "Invalid tool name",
    );
    expect(() => CommandTargets.parse({ id: "tool.bad.command" })).toThrow(
      "Command id must use <tool>.<command>",
    );
  });

  it("preserves constructible adapters, enumerable data, and instanceof behavior", () => {
    const toolName = new ToolNameClass("clean-image-metadata");
    const commandName = new CommandNameClass("get-status");
    const collectionName = new CollectionNameClass("release-notes");
    const rawTarget = new CommandTargetClass("../raw", "nested.command");
    const ids = new CommandIdsClass();

    expect(toolName).toBeInstanceOf(ToolNameClass);
    expect(toolName.parse("tool_2")).toBeInstanceOf(ToolNameClass);
    expect(commandName).toBeInstanceOf(CommandNameClass);
    expect(collectionName).toBeInstanceOf(CollectionNameClass);
    expect(rawTarget).toBeInstanceOf(CommandTargetClass);
    expect(rawTarget.from("tool", "command")).toBeInstanceOf(CommandTargetClass);
    expect(rawTarget.parse("tool.command")).toBeInstanceOf(CommandTargetClass);
    expect(ids).toBeInstanceOf(CommandIdsClass);
    expect(Object.keys(toolName)).toEqual(["value"]);
    expect(Object.keys(commandName)).toEqual(["value"]);
    expect(Object.keys(collectionName)).toEqual(["value"]);
    expect(Object.keys(rawTarget)).toEqual(["tool", "command", "id"]);
    expect(Object.keys(ids)).toEqual([]);
    expect(rawTarget).toEqual({
      tool: "../raw",
      command: "nested.command",
      id: "../raw.nested.command",
    });
    expect(ids.from("clean-image-metadata", "get_metadata")).toBe(
      "clean-image-metadata.get_metadata",
    );
    expect(toolNames).toBeInstanceOf(ToolNameClass);
    expect(commandNames).toBeInstanceOf(CommandNameClass);
    expect(collectionNames).toBeInstanceOf(CollectionNameClass);
    expect(commandTargets).toBeInstanceOf(CommandTargetClass);
    expect(commandIds).toBeInstanceOf(CommandIdsClass);
  });

  it("rejects tool and command names that cannot be routed safely", () => {
    for (const name of ["", ".", "..", "../tool", "/tmp/tool", "folder/tool", "folder\\tool"]) {
      expect(() => new ToolNameClass(name)).toThrow("Invalid tool name");
    }
    expect(() => new ToolNameClass(null as never)).toThrow("Invalid tool name");

    for (const name of ["", ".", "..", "nested.command", "folder/command", "folder\\command"]) {
      expect(() => new CommandNameClass(name)).toThrow("Invalid command name");
    }
    expect(() => new CommandNameClass(null as never)).toThrow("Invalid command name");
    expect(() => new CollectionNameClass("../notes")).toThrow("Invalid collection name");
    expect(() => new CollectionNameClass(null as never)).toThrow("Invalid collection name");
  });

  it("parses exactly one valid tool and command segment", () => {
    expect(commandTargets.parse("socials.post-message")).toMatchObject({
      id: "socials.post-message",
      tool: "socials",
      command: "post-message",
    });
    expect(commandTargets.from("socials", "post-message").id).toBe("socials.post-message");

    for (const id of ["tool", ".command", "tool.", "tool.bad.command", "../tool.command"]) {
      expect(() => commandTargets.parse(id)).toThrow("Command id must use <tool>.<command>");
    }
    expect(() => commandTargets.parse(undefined as never)).toThrow(
      "Command id must use <tool>.<command>",
    );
  });

  it("prevents tool creation outside the base registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-identifier-test-"));
    homes.push(home);
    const creator = new ToolCreatorClass({ homeDir: home });

    await expect(creator.create("../escaped")).rejects.toThrow("Invalid tool name");
    await expect(creator.create("/tmp/escaped")).rejects.toThrow("Invalid tool name");

    const paths = new RigPathsClass({ homeDir: home });
    expect(existsSync(join(paths.rigDir, "escaped"))).toBe(false);
    expect(existsSync(join(home, "escaped"))).toBe(false);
  });
});
