import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { ToolDiscoveryService } from "../../registry/service/tool-discovery";
import { ToolApiMigrationService, toolApiMigrationLayer } from "./tool-api-migration";

describe("Tool API migration", () => {
  it("composes the discovery dependency through the service layer", async () => {
    const discover = vi.fn(() => Effect.succeed([]));
    const discoveryLayer = Layer.succeed(ToolDiscoveryService, {
      discover,
      discoverRegistry: () => Effect.succeed([]),
      find: () => Effect.die(new Error("unused")),
      projectRootFor: () => Effect.succeed("/project"),
    });

    await expect(
      Effect.runPromise(
        ToolApiMigrationService.use((service) => service.inspect()).pipe(
          Effect.provide(toolApiMigrationLayer.pipe(Layer.provide(discoveryLayer))),
        ),
      ),
    ).resolves.toEqual({
      currentVersion: 2,
      ready: true,
      migrations: [],
      unsupported: [],
    });
    expect(discover).toHaveBeenCalledWith({});
  });
});
