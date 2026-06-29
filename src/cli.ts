#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { RigConfigStore } from "./config/config";
import { RigPaths, type PathOptions } from "./config/paths";
import { DevLinkService } from "./dev/dev-link";
import { RigError, RigErrors } from "./errors/RigError";
import { RegistryConfigService } from "./registry/registry";
import { ToolDiscoveryService } from "./registry/discover";
import { RigPackageRoot } from "./runtime/package-root";
import { ToolCreator, ToolFileService, ToolRemover } from "./tools/create";
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
    this.configureCreateCommand();
    this.configureEditCommand();
    this.configureRemoveCommand();
    this.configureRunCommand();
    this.configureTypecheckCommand();
    this.configureDevCommands();
    this.program
      .command("llm.txt")
      .argument("[target]", "Tool name or command id (<tool>.<command>.)")
      .description("Print Rig instructions or tool docs for LLMs.")
      .action(async (target?: string) => {
        if (target) console.log(await new ToolHelpService(this.pathOptions()).render(target));
        else console.log(this.llmText());
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
      .option("--json", "Print full JSON metadata.")
      .option("--plain", "Print a compact plain text command list.")
      .action(async (commandOptions: { json?: boolean; plain?: boolean }) => {
        const service = new ToolListService(this.pathOptions());
        const data = await service.list();
        if (commandOptions.json) this.printJson(data);
        else console.log(service.renderPlain(data));
      });
  }

  private configureInspectCommand(): void {
    this.program
      .command("inspect")
      .argument("<target>", "Tool name or command id (<tool>.<command>.)")
      .description("Print tool or command metadata as JSON.")
      .action(async (target: string) => {
        this.printJson(await new ToolInspector(this.pathOptions()).inspect(target));
      });
  }

  private configureCreateCommand(): void {
    this.program
      .command("create")
      .argument("<tool>")
      .description("Create a starter tool in the base registry.")
      .action(async (name: string) => {
        await this.createTool(name);
      });
  }

  private configureEditCommand(): void {
    this.program
      .command("edit")
      .argument("<tool>")
      .description("Print the TypeScript file path for a tool.")
      .action(async (name: string) => {
        const result = await new ToolFileService(this.pathOptions()).path(name);
        console.log(result.toolPath);
      });
  }

  private configureRemoveCommand(): void {
    this.program
      .command("remove")
      .argument("<tool>")
      .description("Remove a local tool directory.")
      .action(async (name: string) => {
        const result = await new ToolRemover(this.pathOptions()).remove(name);
        console.log(`Removed tool ${result.name}`);
        console.log(`Tool directory: ${result.toolDir}`);
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
      .action(
        async (commandId: string, args: string[], commandOptions: Record<string, unknown>) => {
          await this.runToolCommand(commandId, args, commandOptions);
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
    commandId: string,
    args: string[],
    commandOptions: Record<string, unknown>,
  ): Promise<void> {
    const commandTarget = this.commandTarget(commandId);
    const result = await new ToolRunner(this.pathOptions()).run(
      commandTarget.tool,
      commandTarget.command,
      {
        ...this.pathOptions(),
        args,
        input: commandOptions.input as string | undefined,
        inputFile: commandOptions.inputFile as string | undefined,
        dryRun: Boolean(commandOptions.dryRun),
      },
    );
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
    console.log("  rig list");
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
    console.log(`  rig llm.txt ${result.name}`);
    console.log(`  rig llm.txt ${result.id}`);
    console.log(`  rig run ${result.id} test`);
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

  private llmText(): string {
    return `The \`rig\` CLI is installed on this machine. It allows you to write, run and own local tools and scripts in a typed runtime.

- To discover available tools, run \`rig list\`.
- To learn about a tool's usage, run \`rig llm.txt <tool>\`.
- To run a tool, use \`rig run <tool>.<command> [args]\`.
- To create a new tool, run \`rig create <tool>\`.
- To edit an existing tool, run \`rig edit <tool>\` and open the printed file path.
- To remove an existing tool, run \`rig remove <tool>\`.
`;
  }

  private commandTarget(commandId: string): { tool: string; command: string } {
    const parts = commandId.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new RigError("INPUT_ERROR", `Command id must use <tool>.<command>: ${commandId}`);
    }
    return { tool: parts[0], command: parts[1] };
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
