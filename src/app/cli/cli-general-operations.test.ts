import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { RegistryService } from "../../domains/registry/service/registry";
import { AgentInstructionSyncService } from "../../domains/tools/runtime/agent-instruction-sync";
import { RuntimeSupportService } from "../../domains/tools/runtime/runtime-support";
import type { AgentInstructionSyncResult } from "../../domains/tools/types/agent-instruction";
import {
  type ToolRuntimeInstructionSyncResult,
  ToolRuntimeInstructionSyncService,
} from "../../domains/tools/runtime/tool-runtime-instruction-sync";
import { RigError } from "../../providers/errors/rig-error";
import { CliEnvironmentConfigService } from "./cli-platform";
import { CliGeneratedSyncOperationsService } from "./cli-general-operations";

const syncLayer = (params: {
  agentSync: string;
  tool: Effect.Effect<ToolRuntimeInstructionSyncResult, RigError>;
  agent: Effect.Effect<AgentInstructionSyncResult, RigError>;
}) =>
  CliGeneratedSyncOperationsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CliEnvironmentConfigService, {
          env: { RIG_AGENT_SYNC: params.agentSync },
          argv: [],
        }),
        Layer.succeed(RegistryService, {
          list: Effect.succeed({
            baseRegistryDir: "/tmp/rig",
            customRegistries: [],
            registries: [],
          }),
          add: () => Effect.die("Registry add is unavailable in this test."),
          remove: () => Effect.die("Registry remove is unavailable in this test."),
        }),
        Layer.succeed(RuntimeSupportService, { ensure: () => Effect.void }),
        Layer.succeed(ToolRuntimeInstructionSyncService, { sync: params.tool }),
        Layer.succeed(AgentInstructionSyncService, {
          sync: params.agent,
          discoverTargets: Effect.succeed([]),
          renderBlock: () => Effect.succeed(""),
        }),
      ),
    ),
  );

describe("CliGeneratedSyncOperationsService", () => {
  it("propagates tool instruction sync failures", async () => {
    const expected = new RigError({ code: "INTERNAL_ERROR", message: "tool sync failed" });
    const error = await Effect.runPromise(
      CliGeneratedSyncOperationsService.use((service) => service.sync).pipe(
        Effect.provide(
          syncLayer({
            agentSync: "0",
            tool: Effect.fail(expected),
            agent: Effect.succeed({ skipped: true, targets: [] }),
          }),
        ),
        Effect.flip,
      ),
    );

    expect(error).toBe(expected);
  });

  it("propagates agent instruction sync failures when enabled", async () => {
    const expected = new RigError({ code: "INTERNAL_ERROR", message: "agent sync failed" });
    const error = await Effect.runPromise(
      CliGeneratedSyncOperationsService.use((service) => service.sync).pipe(
        Effect.provide(
          syncLayer({
            agentSync: "1",
            tool: Effect.succeed({ tools: [] }),
            agent: Effect.fail(expected),
          }),
        ),
        Effect.flip,
      ),
    );

    expect(error).toBe(expected);
  });
});
