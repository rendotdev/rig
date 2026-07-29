import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer } from "effect";
import { RigConfigStoreService } from "../../settings/service/config-store";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import { AtomicFileWriterService } from "../../../providers/filesystem/atomic-file-writer";
import { RigPathsService } from "../../../providers/paths/rig-paths";
import { CollectionName, CommandName, CommandTarget, ToolName } from "../types/tool-identifier";
import { toolDefinitionLayer } from "../service/tool-definition";
import { ToolIdentifierService, toolIdentifierLayer } from "../service/tool-identifier";
import { ToolFilesService } from "./tool-files";

describe("routed identifier schemas", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  const runIdentifier = <A, E>(
    use: (service: Context.Service.Shape<typeof ToolIdentifierService>) => Effect.Effect<A, E>,
  ) => Effect.runPromise(ToolIdentifierService.use(use).pipe(Effect.provide(toolIdentifierLayer)));

  it("creates schema entities and command ids", async () => {
    expect(
      await runIdentifier((service) => service.parseToolName("clean-image-metadata")),
    ).toBeInstanceOf(ToolName);
    expect(await runIdentifier((service) => service.parseCommandName("get-status"))).toBeInstanceOf(
      CommandName,
    );
    expect(
      await runIdentifier((service) => service.parseCollectionName("release-notes")),
    ).toBeInstanceOf(CollectionName);
    expect(
      await runIdentifier((service) =>
        service.makeCommandTarget("clean-image-metadata", "get_metadata"),
      ),
    ).toEqual(
      new CommandTarget({
        tool: "clean-image-metadata",
        command: "get_metadata",
        id: "clean-image-metadata.get_metadata",
      }),
    );
    expect(
      await runIdentifier((service) => service.commandId("clean-image-metadata", "get_metadata")),
    ).toBe("clean-image-metadata.get_metadata");
  });

  it("rejects identifiers that cannot be routed safely", async () => {
    await Promise.all(
      ["", ".", "..", "../tool", "/tmp/tool", "folder/tool", "folder\\tool"].map((name) =>
        expect(runIdentifier((service) => service.parseToolName(name))).rejects.toThrow(
          "Invalid tool name",
        ),
      ),
    );
    await Promise.all(
      ["", ".", "..", "nested.command", "folder/command"].map((name) =>
        expect(runIdentifier((service) => service.parseCommandName(name))).rejects.toThrow(
          "Invalid command name",
        ),
      ),
    );
    await expect(
      runIdentifier((service) => service.parseCollectionName("../notes")),
    ).rejects.toThrow("Invalid collection name");
  });

  it("parses exactly one tool and command segment", async () => {
    expect(
      await runIdentifier((service) => service.parseCommandTarget("socials.post-message")),
    ).toMatchObject({
      id: "socials.post-message",
      tool: "socials",
      command: "post-message",
    });
    await Promise.all(
      ["tool", ".command", "tool.", "tool.bad.command", "../tool.command"].map((id) =>
        expect(runIdentifier((service) => service.parseCommandTarget(id))).rejects.toThrow(
          "Command id must use <tool>.<command>",
        ),
      ),
    );
    await expect(runIdentifier((service) => service.parseCommandTarget(undefined))).rejects.toThrow(
      "Command id must use <tool>.<command>",
    );
  });

  it("prevents tool creation outside the base registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-identifier-test-"));
    homes.push(home);
    const filesLayer = ToolFilesService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RigPathsService, {} as Context.Service.Shape<typeof RigPathsService>),
          Layer.succeed(
            RigConfigStoreService,
            {} as Context.Service.Shape<typeof RigConfigStoreService>,
          ),
          Layer.succeed(
            ToolDiscoveryService,
            {} as Context.Service.Shape<typeof ToolDiscoveryService>,
          ),
          Layer.succeed(
            AtomicFileWriterService,
            {} as Context.Service.Shape<typeof AtomicFileWriterService>,
          ),
          toolDefinitionLayer,
        ),
      ),
    );
    const create = (name: string) =>
      Effect.runPromise(
        ToolFilesService.use((service) => service.create(name)).pipe(Effect.provide(filesLayer)),
      );
    await expect(create("../escaped")).rejects.toThrow("Invalid tool name");
    await expect(create("/tmp/escaped")).rejects.toThrow("Invalid tool name");

    expect(existsSync(join(home, "rig", "escaped"))).toBe(false);
    expect(existsSync(join(home, "escaped"))).toBe(false);
  });
});
