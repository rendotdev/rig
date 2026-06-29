#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { RigConfigStore } from "./config/config";
import { RigPaths, type PathOptions } from "./config/paths";
import { DevLinkService } from "./dev/dev-link";
import { RigErrors } from "./errors/RigError";
import { RegistryConfigService } from "./registry/registry";
import { ToolDiscoveryService } from "./registry/discover";
import { RigPackageRoot } from "./runtime/package-root";
import { ToolCreator } from "./tools/create";
import { ToolHelpService } from "./tools/help";
import { ToolInspector } from "./tools/inspect";
import { ToolListService } from "./tools/list";
import { ToolRunner } from "./tools/run";
import { ToolTypecheckService } from "./tools/typecheck";

export class CliApplication {
  private readonly program = new Command();

  async run(argv: string[]): Promise<void> {
    this.configureProgram();
    try {
      if (argv.slice(2).length === 0) {
        await this.showDefaultStatus();
      } else {
        await this.program.parseAsync(argv);
      }
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
    this.configureInspectCommand();
    this.configureToolCommands();
    this.configureRunCommand();
    this.configureTypecheckCommand();
    this.configureDevCommands();
    this.program
      .command("help")
      .argument("[tool]")
      .argument("[command]")
      .description("Print Rig, tool, or command help.")
      .action(async (tool?: string, command?: string) => {
        if (tool) console.log(await new ToolHelpService(this.pathOptions()).render(tool, command));
        else console.log(this.helpText());
      });
    this.program
      .command("llm.txt")
      .description("Print Rig instructions for LLMs.")
      .action(() => {
        console.log(this.llmText());
      });
  }

  private configureInitCommands(): void {
    this.program
      .command("init")
      .description("Create Rig config and base registry if missing.")
      .action(async () => {
        const configStore = new RigConfigStore(this.pathOptions());
        const paths = new RigPaths(this.pathOptions());
        const config = await configStore.ensure();
        console.log("Rig initialized.");
        console.log(`Config: ${paths.configPath}`);
        console.log(`Base registry: ${configStore.registryEntries(config)[0]?.path}`);
      });

    this.program
      .command("doctor")
      .description("Check local Rig setup.")
      .action(async () => {
        await this.doctor();
      });
  }

  private configureConfigCommands(): void {
    const configCommand = this.program.command("config").description("Manage Rig config.");
    configCommand
      .command("show")
      .description("Print config JSON.")
      .action(async () => {
        const configStore = new RigConfigStore(this.pathOptions());
        await configStore.ensure();
        this.printJson(await configStore.read());
      });
    configCommand
      .command("path")
      .description("Print absolute config path.")
      .action(() => {
        console.log(new RigPaths(this.pathOptions()).configPath);
      });
  }

  private configureRegistryCommands(): void {
    const registryCommand = this.program.command("registry").description("Manage tool registries.");
    registryCommand
      .command("list")
      .description("List registries as JSON.")
      .action(async () => {
        this.printJson(await new RegistryConfigService(this.pathOptions()).list());
      });
    registryCommand
      .command("add")
      .argument("<path>")
      .description("Add a custom registry.")
      .action(async (pathValue: string) => {
        this.printJson(await new RegistryConfigService(this.pathOptions()).add(pathValue));
      });
    registryCommand
      .command("remove")
      .argument("<path>")
      .description("Remove a custom registry.")
      .action(async (pathValue: string) => {
        this.printJson(await new RegistryConfigService(this.pathOptions()).remove(pathValue));
      });
  }

  private configureListCommand(): void {
    this.program
      .command("list")
      .alias("ls")
      .description("List discovered tools and commands.")
      .option("--plain", "Print a compact plain text command list.")
      .action(async (commandOptions: { plain?: boolean }) => {
        const service = new ToolListService(this.pathOptions());
        const data = await service.list();
        if (commandOptions.plain) console.log(service.renderPlain(data));
        else this.printJson(data);
      });
  }

  private configureInspectCommand(): void {
    this.program
      .command("inspect")
      .argument("<tool>")
      .argument("[command]")
      .description("Print tool or command metadata as JSON.")
      .action(async (tool: string, command?: string) => {
        this.printJson(await new ToolInspector(this.pathOptions()).inspect(tool, command));
      });
  }

  private configureToolCommands(): void {
    const toolCommand = this.program.command("tool").description("Create and inspect tools.");
    toolCommand
      .command("create")
      .argument("<tool>")
      .description("Create a starter tool in the base registry.")
      .action(async (name: string) => {
        await this.createTool(name);
      });

    toolCommand
      .command("inspect")
      .argument("<tool>")
      .argument("[command]")
      .description("Print tool or command metadata as JSON.")
      .action(async (tool: string, command?: string) => {
        this.printJson(await new ToolInspector(this.pathOptions()).inspect(tool, command));
      });
  }

  private configureRunCommand(): void {
    this.program
      .command("run")
      .argument("<tool>")
      .argument("<command>")
      .argument("[args...]", "Command arguments.")
      .description("Run a tool command.")
      .option("--input <json>", "JSON input string.")
      .option("--input-file <path>", "Read JSON input from a file.")
      .option("--allow-write", "Allow write side effects.")
      .option("--allow-network", "Allow network side effects.")
      .option("--allow-shell", "Allow shell side effects.")
      .option("--allow-destructive", "Allow destructive side effects.")
      .option("--dry-run", "Validate input and show what would run without executing.")
      .action(
        async (
          tool: string,
          command: string,
          args: string[],
          commandOptions: Record<string, unknown>,
        ) => {
          await this.runToolCommand(tool, command, args, commandOptions);
        },
      );
  }

  private configureTypecheckCommand(): void {
    this.program
      .command("typecheck")
      .argument("[tool]")
      .description("Type-check local tool files with the injected Rig tool runtime types.")
      .action(async (tool?: string) => {
        const result = await new ToolTypecheckService(this.pathOptions()).typecheck(tool);
        this.printJson(result);
        process.exitCode = result.exitCode;
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
        const service = new DevLinkService(this.pathOptions());
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
        const service = new DevLinkService(this.pathOptions());
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
        this.printJson(await new DevLinkService(this.pathOptions()).status(commandOptions));
      });
  }

  private async runToolCommand(
    tool: string,
    command: string,
    args: string[],
    commandOptions: Record<string, unknown>,
  ): Promise<void> {
    const result = await new ToolRunner(this.pathOptions()).run(tool, command, {
      ...this.pathOptions(),
      args,
      input: commandOptions.input as string | undefined,
      inputFile: commandOptions.inputFile as string | undefined,
      allowWrite: Boolean(commandOptions.allowWrite),
      allowNetwork: Boolean(commandOptions.allowNetwork),
      allowShell: Boolean(commandOptions.allowShell),
      allowDestructive: Boolean(commandOptions.allowDestructive),
      dryRun: Boolean(commandOptions.dryRun),
    });
    this.printJson(result.envelope);
    process.exitCode = result.exitCode;
  }

  private async showDefaultStatus(): Promise<void> {
    const options = this.pathOptions();
    const paths = new RigPaths(options);
    const configStore = new RigConfigStore(options);
    const config = await configStore.ensure();
    const tools = await new ToolDiscoveryService(options).discover();
    const registries = configStore.registryEntries(config);

    console.log("Rig is ready.\n");
    console.log(`Config:        ${paths.configPath}`);
    console.log(`Base registry: ${registries[0]?.path}`);
    console.log(`Tools found:   ${tools.length}`);
    console.log("\nNext steps:");
    console.log("  rig tool create my-tool");
    console.log("  rig help my-tool");
    console.log("  rig run my-tool example test");
    console.log("  rig llm.txt");
    console.log('\nRun "rig doctor" if you want to verify your setup.');
  }

  private async createTool(name: string): Promise<void> {
    const result = await new ToolCreator(this.pathOptions()).create(name);
    console.log(`Created tool ${result.name}`);
    console.log(`\nTool directory: ${result.toolDir}`);
    console.log(`Tool file:      ${result.toolPath}`);
    console.log("\nFiles:");
    for (const file of result.files) console.log(`  ${file}`);
    console.log(`\nEdit: ${result.toolPath}`);
    console.log("\nTry:");
    console.log(`  rig help ${result.name}`);
    console.log(`  rig help ${result.name} ${result.command}`);
    console.log(`  rig run ${result.name} ${result.command} test`);
  }

  private async doctor(): Promise<void> {
    const options = this.pathOptions();
    const paths = new RigPaths(options);
    const configStore = new RigConfigStore(options);
    const config = await configStore.ensure();
    const registries = configStore.registryEntries(config);
    const tools = await new ToolDiscoveryService(options).discover();

    console.log("Rig doctor\n");
    console.log(`Config:        OK ${paths.configPath}`);
    console.log(`Runtime SDK:   OK ${paths.runtimeSdkPath}`);
    console.log(`Registries:    ${registries.length}`);
    for (const registry of registries) {
      console.log(`  ${registry.kind}: ${registry.path}`);
    }
    console.log(`Tools:         ${tools.length}`);
    console.log("\nStatus: OK");
  }

  private helpText(): string {
    return this.workflowText("# Rig help");
  }

  private llmText(): string {
    return this.workflowText("# Rig llm.txt");
  }

  private workflowText(title: string): string {
    return `${title}

Rig is a typed local command runtime. It runs local TypeScript tools that contain one or more commands.

Use this workflow:

1. Run \`rig list\` to discover tools and command ids.
2. Run \`rig help <tool>\` to read the tool API in plain text.
3. Run \`rig help <tool> <command>\` before using a command.
4. Use \`rig inspect <tool> <command>\` when you need machine-readable schemas and examples.
5. Run commands with \`rig run <tool> <command> [args...]\`. Use \`--input\` or \`--input-file\` when JSON is clearer.
6. Use \`--dry-run\` to validate input and inspect side effects without executing a command.
7. Parse stdout as JSON with top-level \`data\` and \`errors\`.
8. On success, \`errors\` is empty and the command result is in \`data\`.
9. On failure, \`errors\` is non-empty. Read \`errors[0].message\` and \`errors[0].code\`.
10. Treat stderr as logs or human-readable diagnostics.
11. Remember that tools are local TypeScript files on the user's machine.
12. Prefer read-only commands. Ask the user before write, network, shell, or destructive side effects.
13. If Rig returns \`POLICY_CONFIRMATION_REQUIRED\`, show the suggested command from \`errors[0].details.suggestedCommand\` to the user and ask for consent.

A command id looks like \`<tool>.<command>\`, for example \`github.list-prs\`. It is an identifier for discovery and inspection; execute it with \`rig run github list-prs owner=octocat repo=hello-world\`.
`;
  }

  private version(): string {
    try {
      const packageJsonPath = RigPackageRoot.packageFile(import.meta.url, "package.json");
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

  private printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
  }

  private printError(error: unknown): never {
    const rigError = RigErrors.from(error);
    console.error(`${rigError.code}: ${rigError.message}`);
    if (rigError.details !== undefined) {
      console.error(JSON.stringify(rigError.details, null, 2));
    }
    process.exit(1);
  }
}

export function isCliEntrypoint(metaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  return metaUrl === pathToFileURL(argvPath).href;
}

/* v8 ignore next 3 */
if (isCliEntrypoint(import.meta.url)) {
  await new CliApplication().run(process.argv);
}
