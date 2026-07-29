import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import type { CommandDefinition } from "../types/tool-types";
import type { RunCommandOptions, RunCommandResult } from "../types/tool-runner";
import { toolInputParserLayer } from "../service/tool-input-parser";
import { RunInputService, ToolRunnerService, runInputLayer } from "./tool-runner";
import { ToolFilesService, type ToolFileResult } from "./tool-files";
import { ToolTypecheckService, type ToolTypecheckResult } from "./tool-typecheck";
import { ToolHelpService } from "./tool-help";
import { ToolInspectorService } from "./tool-inspector";
import { ToolListService, type ToolListData } from "./tool-list";
import { toolServicesLayer } from "./tool-services-layer";
import { RuntimeSupportService } from "./runtime-support";

export class RunToolTestService extends Context.Service<
  RunToolTestService,
  {
    readonly createTool: (
      name: string,
    ) => Effect.Effect<ToolFileResult & { command: string; id: string; files: string[] }, RigError>;
    readonly renderHelp: (
      toolName: string,
      commandName?: string,
    ) => Effect.Effect<string, RigError>;
    readonly inspect: (toolName: string, commandName?: string) => Effect.Effect<unknown, RigError>;
    readonly typecheck: (toolName?: string) => Effect.Effect<ToolTypecheckResult, RigError>;
    readonly list: Effect.Effect<ToolListData, RigError>;
    readonly renderList: (data: ToolListData) => Effect.Effect<string>;
    readonly runInput: (
      command: CommandDefinition,
      options: RunCommandOptions,
    ) => Effect.Effect<{ value: unknown; source: string }, RigError>;
    readonly run: (
      tool: string,
      command: string,
      options?: RunCommandOptions,
    ) => Effect.Effect<RunCommandResult, RigError>;
  }
>()("@rendotdev/rig/tools/testing/RunToolTestService", {
  make: Effect.gen(function* () {
    const files = yield* ToolFilesService;
    const help = yield* ToolHelpService;
    const inspector = yield* ToolInspectorService;
    const typechecker = yield* ToolTypecheckService;
    const lists = yield* ToolListService;
    const inputs = yield* RunInputService;
    const runner = yield* ToolRunnerService;
    const runtimeSupport = yield* RuntimeSupportService;
    const createTool = Effect.fn("RunToolTestService.createTool")(function* (name: string) {
      yield* runtimeSupport.ensure();
      return yield* files.create(name);
    });
    const renderHelp = Effect.fn("RunToolTestService.renderHelp")(function* (
      toolName: string,
      commandName?: string,
    ) {
      return yield* help.render(toolName, commandName);
    });
    const inspect = Effect.fn("RunToolTestService.inspect")(function* (
      toolName: string,
      commandName?: string,
    ) {
      return yield* inspector.inspect(toolName, commandName);
    });
    const typecheck = Effect.fn("RunToolTestService.typecheck")(function* (toolName?: string) {
      yield* runtimeSupport.ensure();
      return yield* typechecker.typecheck(toolName);
    });
    const list = lists.list().pipe(Effect.withSpan("RunToolTestService.list"));
    const renderList = Effect.fn("RunToolTestService.renderList")(function* (data: ToolListData) {
      return yield* lists.renderPlain(data);
    });
    const runInput = Effect.fn("RunToolTestService.runInput")(function* (
      command: CommandDefinition,
      options: RunCommandOptions,
    ) {
      return yield* inputs.read(command, options);
    });
    const run = Effect.fn("RunToolTestService.run")(function* (
      tool: string,
      command: string,
      options: RunCommandOptions = {},
    ) {
      yield* runtimeSupport.ensure();
      return yield* runner.run(tool, command, options);
    });
    return { createTool, renderHelp, inspect, typecheck, list, renderList, runInput, run } as const;
  }),
}) {
  static readonly layer = Layer.effect(RunToolTestService, RunToolTestService.make);
}

const inputLayer = runInputLayer.pipe(Layer.provide(toolInputParserLayer));
export const runTestHarnessLayer = RunToolTestService.layer.pipe(
  Layer.provide(Layer.merge(toolServicesLayer, inputLayer)),
);
