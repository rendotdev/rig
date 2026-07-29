import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";
import {
  type CliCronAddOptions,
  CliCronOperationsService,
  cliCronOperationsLayer,
  CliDevOperationsService,
  cliDevOperationsLayer,
} from "./cli-cron-dev-operations";
import { CliGeneralOperationsService, cliGeneralOperationsLayer } from "./cli-general-operations";
import {
  type CliFindOptions,
  type CliRunOptions,
  CliToolExecutionOperationsService,
  cliToolExecutionOperationsLayer,
  CliToolReadOperationsService,
  cliToolReadOperationsLayer,
  CliToolWriteOperationsService,
  cliToolWriteOperationsLayer,
} from "./cli-tool-operations";
import { CliUpdateOperationsService, cliUpdateOperationsLayer } from "./cli-update-operations";

export type CliCommandController = Readonly<{
  schedule: (effect: Effect.Effect<void, unknown>, generatedSyncRequested?: boolean) => void;
}>;

export class CliGeneralCommandRegistrationService extends Context.Service<
  CliGeneralCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliGeneralCommandRegistrationService", {
  make: Effect.gen(function* () {
    const operations = yield* CliGeneralOperationsService;
    const configure = Effect.fn("CliGeneralCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      program
        .command("init")
        .description("Initialize config and sync tools to AGENTS.md/CLAUDE.md.")
        .action(() => controller.schedule(operations.defaultStatus, true));
      program
        .command("doctor")
        .description("Check local Rig setup.")
        .action(() => controller.schedule(operations.doctor, true));
      const config = program.command("config").description("Manage Rig config.");
      config
        .command("show")
        .description("Print config JSON.")
        .action(() => controller.schedule(operations.showConfig));
      config
        .command("path")
        .description("Print absolute config path.")
        .action(() => controller.schedule(operations.showConfigPath));
      program
        .command("help")
        .argument("[target]", "Topic, tool name, or command id (<tool>.<command>.)")
        .description("Print topic help, tool docs, or general help.")
        .action((target?: string) =>
          controller.schedule(operations.help(target, program.helpInformation())),
        );
      const registry = program.command("registry").description("Manage tool registries.");
      registry
        .command("list")
        .description("List registries as JSON.")
        .action(() => controller.schedule(operations.listRegistries));
      registry
        .command("create")
        .argument("[path]")
        .description("Add a custom registry. Defaults to the current directory.")
        .action((path?: string) => controller.schedule(operations.addRegistry(path), true));
      registry
        .command("remove")
        .argument("<path>")
        .description("Remove a custom registry.")
        .action((path: string) => controller.schedule(operations.removeRegistry(path), true));
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliGeneralCommandRegistrationService,
    CliGeneralCommandRegistrationService.make,
  );
}

export class CliToolReadCommandRegistrationService extends Context.Service<
  CliToolReadCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliToolReadCommandRegistrationService", {
  make: Effect.gen(function* () {
    const operations = yield* CliToolReadOperationsService;
    const configure = Effect.fn("CliToolReadCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      program
        .command("list")
        .alias("ls")
        .description("List discovered tools and commands.")
        .option("--json", "Print full JSON metadata.")
        .action((options: { json?: boolean }) =>
          controller.schedule(operations.list(Boolean(options.json))),
        );
      program
        .command("find")
        .argument("<query>", "Natural-language description of the command to find.")
        .description("Find commands with local typo-tolerant fuzzy search.")
        .option("--limit <count>", "Maximum results to return, from 1 to 50.", "5")
        .option("--tool <tool>", "Search within one tool.")
        .option("--json", "Print ranked result metadata as JSON.")
        .action((query: string, options: CliFindOptions) =>
          controller.schedule(operations.find(query, options)),
        );
      program
        .command("inspect")
        .argument("<target>", "Tool name or command id (<tool>.<command>.)")
        .description("Print tool or command metadata as JSON.")
        .action((target: string) => controller.schedule(operations.inspect(target)));
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolReadCommandRegistrationService,
    CliToolReadCommandRegistrationService.make,
  );
}

export class CliToolWriteCommandRegistrationService extends Context.Service<
  CliToolWriteCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliToolWriteCommandRegistrationService", {
  make: Effect.gen(function* () {
    const operations = yield* CliToolWriteOperationsService;
    const configure = Effect.fn("CliToolWriteCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      program
        .command("create")
        .argument("<tool>")
        .description("Create a starter tool in the base registry.")
        .action((name: string) => controller.schedule(operations.create(name), true));
      program
        .command("edit")
        .argument("<tool>")
        .description("Print the TypeScript file path for a tool.")
        .action((name: string) => controller.schedule(operations.edit(name)));
      program
        .command("remove")
        .argument("<tool>")
        .description("Remove a local tool directory.")
        .action((name: string) => controller.schedule(operations.remove(name), true));
      program
        .command("env")
        .argument("<tool>", "Tool name.")
        .argument(
          "[assignments...]",
          "Use KEY=VALUE to set values, or remove KEY [KEY...] to remove values.",
        )
        .description("Show, write, or remove tool .env values using its env schema.")
        .action((target: string, assignments: string[]) =>
          controller.schedule(operations.env(target, assignments)),
        );
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolWriteCommandRegistrationService,
    CliToolWriteCommandRegistrationService.make,
  );
}

export class CliToolExecutionCommandRegistrationService extends Context.Service<
  CliToolExecutionCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliToolExecutionCommandRegistrationService", {
  make: Effect.gen(function* () {
    const operations = yield* CliToolExecutionOperationsService;
    const configure = Effect.fn("CliToolExecutionCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      program
        .command("run")
        .argument("<command>", "Command id, formatted as <tool>.<command>.")
        .argument("[args...]", "Command arguments.")
        .description("Run a tool command.")
        .option("--input <json>", "JSON input string.")
        .option("--input-file <path>", "Read JSON input from a file.")
        .option("--dry-run", "Validate input and show what would run without executing.")
        .option("--query <path>", "Print one field from the JSON envelope, such as data.output.")
        .option("--as <id>", "Attach this command's data to a pipeline context under the given id.")
        .option("--pipe", "Read a Rig pipeline context from stdin for @id.path references.")
        .action((commandId: string, args: string[], options: CliRunOptions) =>
          controller.schedule(operations.run(commandId, args, options)),
        );
      program
        .command("typecheck")
        .argument("[tool]")
        .description("Type-check local tool files with the injected Rig tool runtime types.")
        .action((tool?: string) => controller.schedule(operations.typecheck(tool)));
      program
        .command("migrate")
        .description("Inspect local tools for Rig tool API migrations.")
        .option("--json", "Print the migration report as JSON.")
        .action((options: { json?: boolean }) =>
          controller.schedule(operations.migrate(Boolean(options.json))),
        );
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliToolExecutionCommandRegistrationService,
    CliToolExecutionCommandRegistrationService.make,
  );
}

export class CliCronCommandRegistrationService extends Context.Service<
  CliCronCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliCronCommandRegistrationService", {
  make: Effect.gen(function* () {
    const operations = yield* CliCronOperationsService;
    const configure = Effect.fn("CliCronCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      const cron = program.command("cron").description("Manage scheduled Rig tool commands.");
      cron
        .command("list")
        .description("List scheduled Rig tool commands as JSON.")
        .action(() => controller.schedule(operations.list));
      cron
        .command("add")
        .argument("<name>", "Unique job name, using letters, numbers, hyphens, or underscores.")
        .argument("<command>", "Command id, formatted as <tool>.<command>.")
        .argument("<schedule>", "Cron expression or nickname, such as @weekly.")
        .description("Schedule a Rig tool command with fixed JSON input.")
        .option("--input <json>", "JSON input string.")
        .option("--input-file <path>", "Read JSON input from a file.")
        .action((name: string, command: string, schedule: string, options: CliCronAddOptions) =>
          controller.schedule(operations.add(name, command, schedule, options)),
        );
      cron
        .command("remove")
        .argument("<name>", "Cron job name.")
        .description("Remove a scheduled Rig tool command.")
        .action((name: string) => controller.schedule(operations.remove(name)));
      cron
        .command("run")
        .argument("<name>", "Cron job name.")
        .description("Run a scheduled Rig tool command now.")
        .action((name: string) => controller.schedule(operations.run(name)));
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliCronCommandRegistrationService,
    CliCronCommandRegistrationService.make,
  );
}

export class CliDevCommandRegistrationService extends Context.Service<
  CliDevCommandRegistrationService,
  {
    readonly configure: (program: Command, controller: CliCommandController) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/application/CliDevCommandRegistrationService", {
  make: Effect.gen(function* () {
    const dev = yield* CliDevOperationsService;
    const update = yield* CliUpdateOperationsService;
    const configure = Effect.fn("CliDevCommandRegistrationService.configure")(function* (
      program: Command,
      controller: CliCommandController,
    ) {
      const command = program.command("dev").description("Local development helpers.");
      command
        .command("link")
        .description("Link this checkout as the local rig command for development.")
        .option("--bin-dir <path>", "Directory where the rig shim should be written.")
        .option("--force", "Overwrite an existing non-Rig shim.")
        .action((options: { binDir?: string; force?: boolean }) =>
          controller.schedule(dev.link(options)),
        );
      command
        .command("unlink")
        .description("Remove the local rig development shim.")
        .option("--bin-dir <path>", "Directory where the rig shim was written.")
        .option("--force", "Remove even if the file is not a Rig dev shim.")
        .action((options: { binDir?: string; force?: boolean }) =>
          controller.schedule(dev.unlink(options)),
        );
      command
        .command("status")
        .description("Show local rig development shim status as JSON.")
        .option("--bin-dir <path>", "Directory where the rig shim should be checked.")
        .action((options: { binDir?: string }) => controller.schedule(dev.status(options)));
      program
        .command("update")
        .description("Update rig to the latest published version.")
        .action(() => controller.schedule(update.update));
    });
    return { configure } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    CliDevCommandRegistrationService,
    CliDevCommandRegistrationService.make,
  );
}

const cliGeneralCommandRegistrationLayer = CliGeneralCommandRegistrationService.layer.pipe(
  Layer.provide(cliGeneralOperationsLayer),
);
const cliToolReadCommandRegistrationLayer = CliToolReadCommandRegistrationService.layer.pipe(
  Layer.provide(cliToolReadOperationsLayer),
);
const cliToolWriteCommandRegistrationLayer = CliToolWriteCommandRegistrationService.layer.pipe(
  Layer.provide(cliToolWriteOperationsLayer),
);
const cliToolExecutionCommandRegistrationLayer =
  CliToolExecutionCommandRegistrationService.layer.pipe(
    Layer.provide(cliToolExecutionOperationsLayer),
  );
const cliCronCommandRegistrationLayer = CliCronCommandRegistrationService.layer.pipe(
  Layer.provide(cliCronOperationsLayer),
);
const cliDevCommandRegistrationLayer = CliDevCommandRegistrationService.layer.pipe(
  Layer.provide(Layer.merge(cliDevOperationsLayer, cliUpdateOperationsLayer)),
);

export const cliCommandRegistrationLayer = Layer.mergeAll(
  cliGeneralCommandRegistrationLayer,
  cliToolReadCommandRegistrationLayer,
  cliToolWriteCommandRegistrationLayer,
  cliToolExecutionCommandRegistrationLayer,
  cliCronCommandRegistrationLayer,
  cliDevCommandRegistrationLayer,
);
