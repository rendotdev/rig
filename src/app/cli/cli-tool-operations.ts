import { Context, Effect, Layer } from "effect";
import { ToolIdentifierService } from "../../domains/tools/service/tool-identifier";
import { ToolRunnerService } from "../../domains/tools/runtime/tool-runner";
import { ToolEnvService } from "../../domains/tools/runtime/tool-env";
import { ToolFilesService } from "../../domains/tools/runtime/tool-files";
import { ToolTypecheckService } from "../../domains/tools/runtime/tool-typecheck";
import { ToolApiMigrationService } from "../../domains/tools/runtime/tool-api-migration";
import { ToolFindService } from "../../domains/tools/runtime/tool-find";
import { ToolInspectorService } from "../../domains/tools/runtime/tool-inspector";
import { ToolListService } from "../../domains/tools/runtime/tool-list";
import { toolServicesLayer } from "../../domains/tools/runtime/tool-services-layer";
import { CliPlatformService, cliPlatformLayer } from "./cli-platform";
import { pipelineInputLayer, PipelineInputService } from "./pipeline-context";

export type CliFindOptions = Readonly<{ limit?: string; tool?: string; json?: boolean }>;
export type CliRunOptions = Readonly<Record<string, unknown>>;

export class CliToolReadOperationsService extends Context.Service<
  CliToolReadOperationsService,
  {
    readonly list: (json: boolean) => Effect.Effect<void, unknown>;
    readonly find: (query: string, options: CliFindOptions) => Effect.Effect<void, unknown>;
    readonly inspect: (target: string) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliToolReadOperationsService", {
  make: Effect.gen(function* () {
    const platform = yield* CliPlatformService;
    const listService = yield* ToolListService;
    const findService = yield* ToolFindService;
    const inspector = yield* ToolInspectorService;
    const list = Effect.fn("CliToolReadOperationsService.list")(function* (json: boolean) {
      const data = yield* listService.list();
      yield* json ? platform.printJson(data) : platform.log(yield* listService.renderPlain(data));
    });
    const find = Effect.fn("CliToolReadOperationsService.find")(function* (
      query: string,
      options: CliFindOptions,
    ) {
      const data = yield* findService.find(query, options);
      yield* options.json
        ? platform.printJson(data)
        : platform.log(yield* findService.render(data));
    });
    const inspect = Effect.fn("CliToolReadOperationsService.inspect")(function* (target: string) {
      yield* platform.printJson(yield* inspector.inspect(target));
    });
    return { list, find, inspect } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolReadOperationsService,
    CliToolReadOperationsService.make,
  );
}

export class CliToolWriteOperationsService extends Context.Service<
  CliToolWriteOperationsService,
  {
    readonly create: (name: string) => Effect.Effect<void, unknown>;
    readonly edit: (name: string) => Effect.Effect<void, unknown>;
    readonly remove: (name: string) => Effect.Effect<void, unknown>;
    readonly env: (target: string, assignments: string[]) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliToolWriteOperationsService", {
  make: Effect.gen(function* () {
    const platform = yield* CliPlatformService;
    const files = yield* ToolFilesService;
    const environment = yield* ToolEnvService;
    const create = Effect.fn("CliToolWriteOperationsService.create")(function* (name: string) {
      const result = yield* files.create(name);
      yield* platform.log(`Created tool ${result.name}`);
      yield* platform.log(`\nTool directory: ${result.toolDir}`);
      yield* platform.log(`Tool file:      ${result.toolPath}`);
      yield* platform.log("\nFiles:");
      for (const file of result.files) yield* platform.log(`  ${file}`);
      yield* platform.log(`\nEdit: ${result.toolPath}`);
      yield* platform.log("\nTry:");
      yield* platform.log(`  rig help ${result.name}`);
      yield* platform.log(`  rig help ${result.id}`);
      yield* platform.log(`  rig run ${result.id} test`);
    });
    const edit = Effect.fn("CliToolWriteOperationsService.edit")(function* (name: string) {
      yield* platform.log((yield* files.path(name)).toolPath);
    });
    const remove = Effect.fn("CliToolWriteOperationsService.remove")(function* (name: string) {
      const result = yield* files.remove(name);
      yield* platform.log(`Removed tool ${result.name}`);
      yield* platform.log(`Tool directory: ${result.toolDir}`);
    });
    const env = Effect.fn("CliToolWriteOperationsService.env")(function* (
      target: string,
      assignments: string[],
    ) {
      yield* platform.printJson(yield* environment.configure(target, assignments));
    });
    return { create, edit, remove, env } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolWriteOperationsService,
    CliToolWriteOperationsService.make,
  );
}

export class CliToolExecutionOperationsService extends Context.Service<
  CliToolExecutionOperationsService,
  {
    readonly run: (
      commandId: string,
      args: string[],
      options: CliRunOptions,
    ) => Effect.Effect<void, unknown>;
    readonly typecheck: (tool?: string) => Effect.Effect<void, unknown>;
    readonly migrate: (json: boolean) => Effect.Effect<void, unknown>;
  }
>()("@rendotdev/rig/application/CliToolExecutionOperationsService", {
  make: Effect.gen(function* () {
    const platform = yield* CliPlatformService;
    const runner = yield* ToolRunnerService;
    const identifiers = yield* ToolIdentifierService;
    const pipeline = yield* PipelineInputService;
    const typechecker = yield* ToolTypecheckService;
    const migrations = yield* ToolApiMigrationService;
    const run = Effect.fn("CliToolExecutionOperationsService.run")(function* (
      commandId: string,
      args: string[],
      options: CliRunOptions,
    ) {
      const target = yield* identifiers.parseCommandTarget(commandId);
      const pipeContext = options.pipe ? yield* pipeline.read : {};
      const result = yield* runner.run(target.tool, target.command, {
        args,
        input: options.input as string | undefined,
        inputFile: options.inputFile as string | undefined,
        dryRun: Boolean(options.dryRun),
        pipeContext,
      });
      const envelope = yield* pipeline.attach(
        result.envelope,
        pipeContext,
        options.as as string | undefined,
      );
      const query = options.query as string | undefined;
      yield* query
        ? platform.printQueryResult(yield* pipeline.query(envelope, query))
        : platform.printJson(envelope);
      yield* platform.setExitCode(result.exitCode);
    });
    const typecheck = Effect.fn("CliToolExecutionOperationsService.typecheck")(function* (
      tool?: string,
    ) {
      const result = yield* typechecker.typecheck(tool);
      yield* platform.printJson(result);
      yield* platform.setExitCode(result.exitCode);
    });
    const migrate = Effect.fn("CliToolExecutionOperationsService.migrate")(function* (
      json: boolean,
    ) {
      const report = yield* migrations.inspect();
      yield* json ? platform.printJson(report) : platform.log(yield* migrations.renderCli(report));
      yield* platform.setExitCode(report.unsupported.length > 0 ? 2 : 0);
    });
    return { run, typecheck, migrate } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolExecutionOperationsService,
    CliToolExecutionOperationsService.make,
  );
}

const cliToolReadDependenciesLayer = Layer.mergeAll(cliPlatformLayer, toolServicesLayer);
const cliToolWriteDependenciesLayer = Layer.mergeAll(cliPlatformLayer, toolServicesLayer);
const cliToolExecutionDependenciesLayer = Layer.mergeAll(
  cliPlatformLayer,
  pipelineInputLayer,
  toolServicesLayer,
);

export const cliToolReadOperationsLayer = CliToolReadOperationsService.layer.pipe(
  Layer.provide(cliToolReadDependenciesLayer),
);
export const cliToolWriteOperationsLayer = CliToolWriteOperationsService.layer.pipe(
  Layer.provide(cliToolWriteDependenciesLayer),
);
export const cliToolExecutionOperationsLayer = CliToolExecutionOperationsService.layer.pipe(
  Layer.provide(cliToolExecutionDependenciesLayer),
);
