#!/usr/bin/env bun
import { Command } from "commander";
import { RigConfigStore } from "./config/config";
import { RigPaths, type PathOptions } from "./config/paths";
import { RigError, RigErrors } from "./errors/RigError";
import { RegistryConfigService } from "./registry/registry";
import { ToolDiscoveryService } from "./registry/discover";
import { ToolCreator } from "./tools/create";
import { ToolHelpService } from "./tools/help";
import { ToolInspector } from "./tools/inspect";
import { ToolListService } from "./tools/list";
import { ToolRunner } from "./tools/run";

class CliApplication {
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
      if (error instanceof RigError) this.printError(error);
      this.printError(error);
    }
  }

  private configureProgram(): void {
    this.program
      .name("rig")
      .description("Local typed command runtime for agents.")
      .version("0.0.1");
    this.configureInitCommands();
    this.configureConfigCommands();
    this.configureRegistryCommands();
    this.configureToolsCommands();
    this.configureToolCommands();
    this.configureRunCommand();
    this.program
      .command("help-agent")
      .description("Print agent-facing instructions in Markdown.")
      .action(() => {
        console.log(this.helpAgentText());
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

  private configureToolsCommands(): void {
    const toolsCommand = this.program.command("tools").description("Discover tools.");
    toolsCommand
      .command("list")
      .description("List discovered tools and commands.")
      .option("--plain", "Print a plain text list.")
      .action(async (commandOptions: { plain?: boolean }) => {
        const service = new ToolListService(this.pathOptions());
        const data = await service.list();
        if (commandOptions.plain) console.log(service.renderPlain(data));
        else this.printJson(data);
      });
  }

  private configureToolCommands(): void {
    const toolCommand = this.program
      .command("tool")
      .description("Create, inspect, and help tools.");
    toolCommand
      .command("create")
      .argument("<tool>")
      .description("Create a starter tool in the base registry.")
      .action(async (name: string) => {
        await this.createTool(name);
      });

    toolCommand
      .command("help")
      .argument("<tool>")
      .argument("[command]")
      .description("Print tool or command help from the tool definition.")
      .action(async (tool: string, command?: string) => {
        console.log(await new ToolHelpService(this.pathOptions()).render(tool, command));
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
      .description("Run a tool command.")
      .option("--input <json>", "JSON input string.")
      .option("--input-file <path>", "Read JSON input from a file.")
      .option("--allow-write", "Allow write side effects.")
      .option("--allow-network", "Allow network side effects.")
      .option("--allow-shell", "Allow shell side effects.")
      .option("--allow-destructive", "Allow destructive side effects.")
      .action(async (tool: string, command: string, commandOptions: Record<string, unknown>) => {
        const result = await new ToolRunner(this.pathOptions()).run(tool, command, {
          ...this.pathOptions(),
          input: commandOptions.input as string | undefined,
          inputFile: commandOptions.inputFile as string | undefined,
          allowWrite: Boolean(commandOptions.allowWrite),
          allowNetwork: Boolean(commandOptions.allowNetwork),
          allowShell: Boolean(commandOptions.allowShell),
          allowDestructive: Boolean(commandOptions.allowDestructive),
        });
        this.printJson(result.envelope);
        process.exitCode = result.exitCode;
      });
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
    console.log("  rig tool create hello");
    console.log("  rig tool help hello");
    console.log('  rig run hello greet --input \'{"name":"world"}\'');
    console.log("  rig help-agent");
    console.log('\nRun "rig doctor" if you want to verify your setup.');
  }

  private async createTool(name: string): Promise<void> {
    const result = await new ToolCreator(this.pathOptions()).create(name);
    console.log(`Created tool ${result.name}`);
    console.log(`\nPath: ${result.toolDir}`);
    console.log("Files:");
    for (const file of result.files) console.log(`  ${file}`);
    console.log("\nTry:");
    console.log(`  rig tool help ${result.name}`);
    console.log(`  rig tool help ${result.name} ${result.command}`);
    console.log(`  rig run ${result.name} ${result.command} --input '{"name":"world"}'`);
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

  private helpAgentText(): string {
    return `# Rig agent instructions

Rig is a typed local command runtime. It runs local TypeScript tools that contain one or more commands.

Use this workflow:

1. Run \`rig tools list\` to discover tools and command ids.
2. Run \`rig tool help <tool>\` to read the tool API in plain text.
3. Run \`rig tool help <tool> <command>\` before using a command.
4. Use \`rig tool inspect <tool> <command>\` when you need machine-readable schemas and examples.
5. Run commands with \`rig run <tool> <command> --input '<json>'\` or \`--input-file ./input.json\`.
6. Parse stdout as GraphQL-inspired JSON: \`data\`, \`errors\`, and \`extensions\`.
7. On success, read the result at \`data.<tool>.<command>\`.
8. On failure, read \`errors[0].message\` and \`errors[0].extensions.code\`.
9. Treat stderr as logs or human-readable diagnostics.
10. Remember that tools are local TypeScript files on the user's machine.
11. Prefer read-only commands. Ask the user before write, network, shell, or destructive side effects.
12. If Rig returns \`POLICY_CONFIRMATION_REQUIRED\`, show the suggested command from \`errors[0].extensions.details.suggestedCommand\` to the user and ask for consent.

A command id looks like \`<tool>.<command>\`, for example \`github.list-prs\`. The CLI run syntax keeps those as separate arguments, for example \`rig run github list-prs --input '{}'\`.
`;
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

await new CliApplication().run(process.argv);
