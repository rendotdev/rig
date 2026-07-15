import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import type { RigDirectoryMigrationResult } from "../../config/migration";
import type { PathOptions } from "../../config/paths";
import { rigErrors } from "../../errors/RigError";
import { RigLoggerFactoryClass } from "../../runtime/logger";
import { rigPackageRoot } from "../../runtime/package-root";
import { commandTargets } from "../../tools/identifiers";
import { RunPipelineContextServiceClass } from "./pipeline-context";

export class CliApplicationClass {
  private program!: Command;
  private generatedSyncRequested = false;

  async run(argv: string[]): Promise<void> {
    const { Command } = await import("commander");
    this.program = new Command();
    this.generatedSyncRequested = false;
    this.configureProgram();
    try {
      if (argv.slice(2).length === 0) {
        this.requestGeneratedSync();
        await this.showDefaultStatus();
      } else {
        await this.program.parseAsync(argv);
      }
      if (this.generatedSyncRequested) await this.syncGeneratedFiles();
    } catch (error) {
      this.printError(error);
    }
  }

  private configureProgram(): void {
    this.program
      .name("rig")
      .description("Local typed command runtime for agents.")
      .version(this.version())
      .addHelpCommand(false);
    this.configureInitCommands();
    this.configureConfigCommands();
    this.configureRegistryCommands();
    this.configureListCommand();
    this.configureFindCommand();
    this.configureInspectCommand();
    this.configureCreateCommand();
    this.configureEditCommand();
    this.configureRemoveCommand();
    this.configureEnvCommand();
    this.configureRunCommand();
    this.configureCronCommands();
    this.configureTypecheckCommand();
    this.configureDevCommands();
    this.configureUpdateCommand();
    this.program
      .command("help")
      .argument("[target]", "Topic, tool name, or command id (<tool>.<command>).")
      .description("Print topic help, tool docs, or general help.")
      .action(async (target?: string) => {
        if (!target) {
          const readmePath = rigPackageRoot.packageFile(import.meta.url, "README.md");
          /* v8 ignore else */
          if (existsSync(readmePath)) {
            console.log(readFileSync(readmePath, "utf8"));
          } else {
            /* v8 ignore next */
            console.log(this.program.helpInformation());
          }
          return;
        }
        /* v8 ignore start */
        if (target === "topics") {
          const { helpTopicService } = await import("../../tools/help-topics");
          console.log(helpTopicService.renderTopicList());
          return;
        }
        const { helpTopicService } = await import("../../tools/help-topics");
        const topicContent = helpTopicService.render(target);
        if (topicContent) {
          console.log(topicContent);
          return;
        }
        /* v8 ignore stop */
        const { ToolHelpServiceClass } = await import("../../tools/help");
        console.log(await new ToolHelpServiceClass(this.pathOptions()).render(target));
      });
  }

  private configureInitCommands(): void {
    this.program
      .command("init")
      .description("Initialize config and sync tools to AGENTS.md/CLAUDE.md.")
      .action(async () => {
        this.requestGeneratedSync();
        await this.showDefaultStatus();
      });

    this.program
      .command("doctor")
      .description("Check local Rig setup.")
      .action(async () => {
        this.requestGeneratedSync();
        await this.doctor();
      });
  }

  private configureConfigCommands(): void {
    const configCommand = this.program.command("config").description("Manage Rig config.");
    configCommand
      .command("show")
      .description("Print config JSON.")
      .action(async () => {
        const { RigConfigStoreClass } = await import("../../config/config");
        const configStore = new RigConfigStoreClass(this.pathOptions());
        await configStore.ensure();
        this.printJson(await configStore.read());
      });
    configCommand
      .command("path")
      .description("Print absolute config path.")
      .action(async () => {
        const { RigPathsClass } = await import("../../config/paths");
        console.log(new RigPathsClass(this.pathOptions()).configPath);
      });
  }

  private configureRegistryCommands(): void {
    const registryCommand = this.program.command("registry").description("Manage tool registries.");
    registryCommand
      .command("list")
      .description("List registries as JSON.")
      .action(async () => {
        const { RegistryConfigServiceClass } = await import("../../registry/registry");
        this.printJson(await new RegistryConfigServiceClass(this.pathOptions()).list());
      });
    registryCommand
      .command("create")
      .argument("[path]")
      .description("Add a custom registry. Defaults to the current directory.")
      .action(async (pathValue?: string) => {
        this.requestGeneratedSync();
        const { RegistryConfigServiceClass } = await import("../../registry/registry");
        this.printJson(
          await new RegistryConfigServiceClass(this.pathOptions()).add(pathValue ?? process.cwd()),
        );
      });
    registryCommand
      .command("remove")
      .argument("<path>")
      .description("Remove a custom registry.")
      .action(async (pathValue: string) => {
        this.requestGeneratedSync();
        const { RegistryConfigServiceClass } = await import("../../registry/registry");
        this.printJson(await new RegistryConfigServiceClass(this.pathOptions()).remove(pathValue));
      });
  }

  private configureListCommand(): void {
    this.program
      .command("list")
      .alias("ls")
      .description("List discovered tools and commands.")
      .option("--json", "Print full JSON metadata.")
      .action(async (commandOptions: { json?: boolean }) => {
        const { ToolListServiceClass } = await import("../../tools/list");
        const service = new ToolListServiceClass(this.pathOptions());
        const data = await service.list();
        if (commandOptions.json) this.printJson(data);
        else console.log(service.renderPlain(data));
      });
  }

  private configureFindCommand(): void {
    this.program
      .command("find")
      .argument("<query>", "Natural-language description of the command to find.")
      .description("Find commands with local typo-tolerant fuzzy search.")
      .option("--limit <count>", "Maximum results to return, from 1 to 50.", "5")
      .option("--tool <tool>", "Search within one tool.")
      .option("--json", "Print ranked result metadata as JSON.")
      .action(
        async (
          query: string,
          commandOptions: { limit?: string; tool?: string; json?: boolean },
        ) => {
          const { ToolFindServiceClass } = await import("../../tools/find");
          const service = new ToolFindServiceClass(this.pathOptions());
          const data = await service.find({ query, options: commandOptions });
          if (commandOptions.json) this.printJson(data);
          else console.log(service.renderPlain({ data }));
        },
      );
  }

  private configureInspectCommand(): void {
    this.program
      .command("inspect")
      .argument("<target>", "Tool name or command id (<tool>.<command>.)")
      .description("Print tool or command metadata as JSON.")
      .action(async (target: string) => {
        const { ToolInspectorClass } = await import("../../tools/inspect");
        this.printJson(await new ToolInspectorClass(this.pathOptions()).inspect(target));
      });
  }

  private configureCreateCommand(): void {
    this.program
      .command("create")
      .argument("<tool>")
      .description("Create a starter tool in the base registry.")
      .action(async (name: string) => {
        this.requestGeneratedSync();
        await this.createTool(name);
      });
  }

  private configureEditCommand(): void {
    this.program
      .command("edit")
      .argument("<tool>")
      .description("Print the TypeScript file path for a tool.")
      .action(async (name: string) => {
        const { ToolFileServiceClass } = await import("../../tools/create");
        const result = await new ToolFileServiceClass(this.pathOptions()).path(name);
        console.log(result.toolPath);
      });
  }

  private configureRemoveCommand(): void {
    this.program
      .command("remove")
      .argument("<tool>")
      .description("Remove a local tool directory.")
      .action(async (name: string) => {
        this.requestGeneratedSync();
        const { ToolRemoverClass } = await import("../../tools/create");
        const result = await new ToolRemoverClass(this.pathOptions()).remove(name);
        console.log(`Removed tool ${result.name}`);
        console.log(`Tool directory: ${result.toolDir}`);
      });
  }

  private configureEnvCommand(): void {
    this.program
      .command("env")
      .argument("<tool>", "Tool name.")
      .argument(
        "[assignments...]",
        "Use KEY=VALUE to set values, or remove KEY [KEY...] to remove values.",
      )
      .description("Show, write, or remove tool .env values using its env schema.")
      .action(async (target: string, assignments: string[]) => {
        const { ToolEnvServiceClass } = await import("../../tools/env");
        this.printJson(
          await new ToolEnvServiceClass(this.pathOptions()).configure(target, assignments),
        );
      });
  }

  private configureRunCommand(): void {
    this.program
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
      .action(
        async (commandId: string, args: string[], commandOptions: Record<string, unknown>) => {
          await this.runToolCommand(commandId, args, commandOptions);
        },
      );
  }

  private configureCronCommands(): void {
    const cronCommand = this.program
      .command("cron")
      .description("Manage scheduled Rig tool commands.");

    cronCommand
      .command("list")
      .description("List scheduled Rig tool commands as JSON.")
      .action(async () => {
        const { RigCronServiceClass } = await import("../../tools/cron");
        this.printJson(await new RigCronServiceClass(this.pathOptions(), {}).list());
      });

    cronCommand
      .command("add")
      .argument("<name>", "Unique job name, using letters, numbers, hyphens, or underscores.")
      .argument("<command>", "Command id, formatted as <tool>.<command>.")
      .argument("<schedule>", "Cron expression or nickname, such as @weekly.")
      .description("Schedule a Rig tool command with fixed JSON input.")
      .option("--input <json>", "JSON input string.")
      .option("--input-file <path>", "Read JSON input from a file.")
      .action(
        async (
          name: string,
          commandId: string,
          schedule: string,
          commandOptions: { input?: string; inputFile?: string },
        ) => {
          const { cronModuleUrl, RigCronServiceClass } = await import("../../tools/cron");
          const result = await new RigCronServiceClass(this.pathOptions(), {}).add({
            name,
            command: commandId,
            schedule,
            input: commandOptions.input,
            inputFile: commandOptions.inputFile,
            moduleUrl: cronModuleUrl(import.meta.url),
          });
          this.printJson(result);
        },
      );

    cronCommand
      .command("remove")
      .argument("<name>", "Cron job name.")
      .description("Remove a scheduled Rig tool command.")
      .action(async (name: string) => {
        const { RigCronServiceClass } = await import("../../tools/cron");
        this.printJson(await new RigCronServiceClass(this.pathOptions(), {}).remove({ name }));
      });

    cronCommand
      .command("run")
      .argument("<name>", "Cron job name.")
      .description("Run a scheduled Rig tool command now.")
      .action(async (name: string) => {
        const { RigCronServiceClass } = await import("../../tools/cron");
        const result = await new RigCronServiceClass(this.pathOptions(), {}).run({ name });
        this.printJson(result.envelope);
        process.exitCode = result.exitCode;
      });
  }

  private configureTypecheckCommand(): void {
    this.program
      .command("typecheck")
      .argument("[tool]")
      .description("Type-check local tool files with the injected Rig tool runtime types.")
      .action(async (tool?: string) => {
        const { ToolTypecheckServiceClass } = await import("../../tools/typecheck");
        const result = await new ToolTypecheckServiceClass(this.pathOptions()).typecheck(tool);
        this.printJson(result);
        process.exitCode = result.exitCode;
      });
  }

  /* v8 ignore next 20 */
  private configureUpdateCommand(): void {
    this.program
      .command("update")
      .description("Update rig to the latest published version.")
      .action(async () => {
        const $ = (globalThis as typeof globalThis & { Bun: { $: unknown } }).Bun.$;
        const currentVersion = this.version();
        const pm = this.detectPackageManager();
        console.log(`Current version: ${currentVersion}`);
        console.log(`Updating via ${pm}...`);
        const cmd =
          pm === "bun"
            ? $`bun install -g @rendotdev/rig@latest`.quiet().nothrow()
            : $`npm install -g @rendotdev/rig@latest --force`.quiet().nothrow();
        const result = await cmd;
        if (result.exitCode !== 0) {
          console.error("Update failed.");
          process.exit(1);
        }
        const check = await $`rig --version`.quiet().text();
        const newVersion = check.trim();
        if (newVersion === currentVersion) {
          console.log(`Already on the latest version (${currentVersion}).`);
        } else {
          console.log(`Updated: ${currentVersion} -> ${newVersion}`);
        }
        await $`rig init`;
      });
  }

  private configureDevCommands(): void {
    const devCommand = this.program.command("dev").description("Local development helpers.");
    devCommand
      .command("link")
      .description("Link this checkout as the local rig command for development.")
      .option("--bin-dir <path>", "Directory where the rig shim should be written.")
      .option("--force", "Overwrite an existing non-Rig shim.")
      .action(async (commandOptions: { binDir?: string; force?: boolean }) => {
        const { DevLinkServiceClass } = await import("../../dev/dev-link");
        const service = new DevLinkServiceClass(this.pathOptions());
        const status = await service.link({
          binDir: commandOptions.binDir,
          force: Boolean(commandOptions.force),
        });
        console.log(service.renderLinkResult(status));
      });

    devCommand
      .command("unlink")
      .description("Remove the local rig development shim.")
      .option("--bin-dir <path>", "Directory where the rig shim was written.")
      .option("--force", "Remove even if the file is not a Rig dev shim.")
      .action(async (commandOptions: { binDir?: string; force?: boolean }) => {
        const { DevLinkServiceClass } = await import("../../dev/dev-link");
        const service = new DevLinkServiceClass(this.pathOptions());
        const status = await service.unlink({
          binDir: commandOptions.binDir,
          force: Boolean(commandOptions.force),
        });
        console.log(service.renderUnlinkResult(status));
      });

    devCommand
      .command("status")
      .description("Show local rig development shim status as JSON.")
      .option("--bin-dir <path>", "Directory where the rig shim should be checked.")
      .action(async (commandOptions: { binDir?: string }) => {
        const { DevLinkServiceClass } = await import("../../dev/dev-link");
        this.printJson(await new DevLinkServiceClass(this.pathOptions()).status(commandOptions));
      });
  }

  private async runToolCommand(
    commandId: string,
    args: string[],
    commandOptions: Record<string, unknown>,
  ): Promise<void> {
    const { ToolRunnerClass } = await import("../../tools/run");
    const commandTarget = this.commandTarget(commandId);
    const pipeline = new RunPipelineContextServiceClass();
    /* v8 ignore next */
    const pipeContext = commandOptions.pipe ? pipeline.readFromStdin() : {};
    const result = await new ToolRunnerClass(this.pathOptions()).run(
      commandTarget.tool,
      commandTarget.command,
      {
        ...this.pathOptions(),
        args,
        input: commandOptions.input as string | undefined,
        inputFile: commandOptions.inputFile as string | undefined,
        dryRun: Boolean(commandOptions.dryRun),
        pipeContext,
      },
    );
    const envelope = pipeline.withOutputId(
      result.envelope,
      pipeContext,
      commandOptions.as as string | undefined,
    );
    const query = commandOptions.query as string | undefined;
    if (query) this.printQueryResult(pipeline.query(envelope, query));
    else this.printJson(envelope);
    process.exitCode = result.exitCode;
  }

  private async showDefaultStatus(): Promise<void> {
    const [{ RigConfigStoreClass }, { RigPathsClass }, { ToolDiscoveryServiceClass }] =
      await Promise.all([
        import("../../config/config"),
        import("../../config/paths"),
        import("../../registry/discover"),
      ]);
    const options = this.pathOptions();
    const paths = new RigPathsClass(options);
    const configStore = new RigConfigStoreClass(options);
    const config = await configStore.ensure();
    const tools = await new ToolDiscoveryServiceClass(options).discover();
    const registries = configStore.registryEntries(config);
    const currentVersion = this.version();

    new RigLoggerFactoryClass(options)
      .app("cli")
      .info({ version: currentVersion, tools: tools.length }, "Default status rendered.");
    if (this.printMigrationNotice(configStore.migrationResult())) {
      await configStore.acknowledgeMigrationPrompt();
    }
    console.log("Rig is ready.\n");
    console.log(`Version:       ${currentVersion}`);
    console.log(`Config:        ${paths.configPath}`);
    console.log(`Base registry: ${registries[0]?.path}`);
    const customRegistries = registries.filter((r) => r.kind === "custom");
    /* v8 ignore next 5 */
    if (customRegistries.length > 0) {
      console.log("Custom registries:");
      for (const reg of customRegistries) {
        console.log(`  ${reg.path}`);
      }
    }
    console.log(`Tools found:   ${tools.length}`);
    console.log("\nNext steps:");
    console.log("  rig list");
    console.log('\nRun "rig doctor" if you want to verify your setup.');
    await this.printUpdateNotice(currentVersion);
  }

  private async createTool(name: string): Promise<void> {
    const { ToolCreatorClass } = await import("../../tools/create");
    const result = await new ToolCreatorClass(this.pathOptions()).create(name);
    console.log(`Created tool ${result.name}`);
    console.log(`\nTool directory: ${result.toolDir}`);
    console.log(`Tool file:      ${result.toolPath}`);
    console.log("\nFiles:");
    for (const file of result.files) console.log(`  ${file}`);
    console.log(`\nEdit: ${result.toolPath}`);
    console.log("\nTry:");
    console.log(`  rig help ${result.name}`);
    console.log(`  rig help ${result.id}`);
    console.log(`  rig run ${result.id} test`);
  }

  private async doctor(): Promise<void> {
    const [{ RigConfigStoreClass }, { RigPathsClass }, { ToolDiscoveryServiceClass }] =
      await Promise.all([
        import("../../config/config"),
        import("../../config/paths"),
        import("../../registry/discover"),
      ]);
    const options = this.pathOptions();
    const paths = new RigPathsClass(options);
    const configStore = new RigConfigStoreClass(options);
    const config = await configStore.ensure();
    if (this.printMigrationNotice(configStore.migrationResult())) {
      await configStore.acknowledgeMigrationPrompt();
    }
    const registries = configStore.registryEntries(config);
    const tools = await new ToolDiscoveryServiceClass(options).discover();

    new RigLoggerFactoryClass(options)
      .app("doctor")
      .info({ registries: registries.length, tools: tools.length }, "Doctor check completed.");
    console.log("Rig doctor\n");
    console.log(`Config:        OK ${paths.configPath}`);
    console.log(`Runtime SDK:   OK ${paths.runtimeSdkPath}`);
    console.log(`Registries:    ${registries.length}`);
    for (const registry of registries) {
      console.log(`  ${registry.kind}: ${registry.path}`);
    }
    console.log(`Tools:         ${tools.length}`);
    console.log("\nStatus: OK");
    await this.printUpdateNotice(this.version());
  }

  private printMigrationNotice(migration: RigDirectoryMigrationResult | undefined): boolean {
    if (!migration) return false;

    if (migration.status === "migrated") {
      console.log("Rig moved its home folder:");
      console.log(`  From: ${migration.legacyDir}`);
      console.log(`  To:   ${migration.currentDir}`);
      if (migration.configUpdated) console.log("  Updated base registry: ~/rig/tools");
      console.log("");
      return false;
    }

    console.log("Rig home folder migration needs your attention:");
    console.log(`  Old folder: ${migration.legacyDir}`);
    console.log(`  New folder: ${migration.currentDir}`);
    console.log(`  Reason: ${migration.reason}`);
    console.log("Move the files you want to keep into the new folder, then remove the old folder.");
    console.log("This migration prompt is versioned; Rig will not show it again after this run.");
    console.log("");
    return true;
  }

  private async printUpdateNotice(currentVersion: string): Promise<void> {
    await this.ignoreSyncErrors(async () => {
      const { NpmUpdateCheckServiceClass } = await import("../../runtime/update-check");
      const notice = await new NpmUpdateCheckServiceClass(this.pathOptions()).check(currentVersion);
      /* v8 ignore next */
      if (notice) console.log(`\n${notice.message}`);
    });
  }

  private requestGeneratedSync(): void {
    this.generatedSyncRequested = true;
  }

  private async syncGeneratedFiles(): Promise<void> {
    await this.ignoreSyncErrors(async () => {
      const { ToolRuntimeInstructionSyncServiceClass } =
        await import("../../tools/runtime-instruction");
      await new ToolRuntimeInstructionSyncServiceClass(this.pathOptions()).sync();
    });

    if (process.env.RIG_AGENT_SYNC === "0") return;

    await this.ignoreSyncErrors(async () => {
      const { AgentInstructionSyncServiceClass } = await import("../../agents/sync");
      await new AgentInstructionSyncServiceClass(this.pathOptions()).sync();
    });
  }

  private async ignoreSyncErrors(sync: () => Promise<void>): Promise<void> {
    try {
      await sync();
    } catch {
      // Generated file sync should never block the requested Rig command.
    }
  }

  private commandTarget(commandId: string): { tool: string; command: string } {
    return commandTargets.parse(commandId);
  }

  /* v8 ignore start */
  private detectPackageManager(): "bun" | "npm" {
    const entrypoint = (process.argv[1] ?? "").replaceAll("\\", "/");
    return entrypoint.includes("/.bun/") ? "bun" : "npm";
  }
  /* v8 ignore stop */

  private version(): string {
    try {
      const packageJsonPath = rigPackageRoot.packageFile(import.meta.url, "package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        version?: unknown;
      };
      return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  private pathOptions(): PathOptions {
    return process.env.RIG_HOME ? { homeDir: process.env.RIG_HOME } : {};
  }

  private printQueryResult(value: unknown): void {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      console.log(String(value));
      return;
    }
    this.printJson(value);
  }

  private printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
  }

  private printError(error: unknown): never {
    const rigError = rigErrors.from(error);
    console.error(`${rigError.code}: ${rigError.message}`);
    if (rigError.details !== undefined) {
      console.error(JSON.stringify(rigError.details, null, 2));
    }
    process.exit(1);
  }
}
