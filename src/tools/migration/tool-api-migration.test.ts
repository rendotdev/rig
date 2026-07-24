import { describe, expect, it, vi } from "vite-plus/test";
import { ToolDiscoveryServiceClass } from "../../registry/discover";
import { ToolApiMigration } from "./tool-api-migration";

describe("Tool API migration", () => {
  it("creates the production discovery service", async () => {
    const discover = vi
      .spyOn(ToolDiscoveryServiceClass.prototype, "discover")
      .mockResolvedValue([]);

    await expect(ToolApiMigration.inspect({})).resolves.toEqual({
      currentVersion: 2,
      ready: true,
      migrations: [],
      unsupported: [],
    });
    expect(discover).toHaveBeenCalledWith({});
  });
});
