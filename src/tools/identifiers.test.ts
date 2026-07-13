import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RigPathsClass } from "../config/paths";
import { ToolCreatorClass } from "./create";
import {
  CollectionNameClass,
  CommandNameClass,
  commandTargets,
  ToolNameClass,
} from "./identifiers";
import { commandIds } from "./types";

describe("routed identifiers", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("accepts existing tool and command naming conventions", () => {
    expect(new ToolNameClass("clean-image-metadata").value).toBe("clean-image-metadata");
    expect(new ToolNameClass("tool_2").value).toBe("tool_2");
    expect(new CommandNameClass("get-status").value).toBe("get-status");
    expect(new CollectionNameClass("release-notes").value).toBe("release-notes");
    expect(commandIds.from("clean-image-metadata", "get_metadata")).toBe(
      "clean-image-metadata.get_metadata",
    );
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
