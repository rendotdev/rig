import { defineService } from "../../define";
import type { ConfigOptions } from "../../config/config";
import { RigErrorClass } from "../../errors/RigError";
import { ToolLoaderClass } from "../loader";
import { SchemaRenderer } from "../schema";
import { CommandIdsSingleton, type CommandDefinition } from "../types";
import { CommandTargetSingleton, ToolNameSingleton } from "../identifiers";

type ToolInspectorLoader = Pick<ToolLoaderClass, "loadDefinition">;

const ToolInspectorServiceDeps: {
  createLoader: (params: { options: ConfigOptions }) => ToolInspectorLoader;
  commandIds: typeof CommandIdsSingleton;
  commandTargets: typeof CommandTargetSingleton;
  toolNames: typeof ToolNameSingleton;
  schemaRenderer: typeof SchemaRenderer;
} = {
  createLoader: function createLoader(params: { options: ConfigOptions }) {
    return new ToolLoaderClass(params.options);
  },
  commandIds: CommandIdsSingleton,
  commandTargets: CommandTargetSingleton,
  toolNames: ToolNameSingleton,
  schemaRenderer: SchemaRenderer,
};

export class ToolInspectorService extends defineService({
  params: {} as ConfigOptions,
  deps: ToolInspectorServiceDeps,
}) {
  private get loader() {
    return this.deps.createLoader({ options: this.params });
  }

  private inspectTarget(params: { toolName: string; commandName?: string }): {
    toolName: string;
    commandName?: string;
  } {
    if (params.commandName) {
      const target = this.deps.commandTargets.from({
        tool: params.toolName,
        command: params.commandName,
      });
      return { toolName: target.tool, commandName: target.command };
    }
    if (!params.toolName.includes(".")) {
      return { toolName: this.deps.toolNames.create({ value: params.toolName }).value };
    }
    const target = this.deps.commandTargets.parse({ id: params.toolName });
    return { toolName: target.tool, commandName: target.command };
  }

  private commandMetadata(params: { toolName: string; name: string; command: CommandDefinition }) {
    return {
      name: params.name,
      id: this.deps.commandIds.from({ tool: params.toolName, command: params.name }),
      description: params.command.description,
      inputSchema: this.deps.schemaRenderer.toJsonSchema({ schema: params.command.input }),
      outputSchema: this.deps.schemaRenderer.toJsonSchema({ schema: params.command.output }),
      run: `rig run ${this.deps.commandIds.from({ tool: params.toolName, command: params.name })} [args...]`,
      examples: params.command.examples ?? [],
    };
  }

  public async inspect(params: { toolName: string; commandName?: string }) {
    const target = this.inspectTarget(params);
    const loaded = await this.loader.loadDefinition(target.toolName);
    const definition = loaded.definition;

    if (target.commandName) {
      const command = definition.commands[target.commandName];
      if (!command) {
        throw new RigErrorClass(
          "COMMAND_NOT_FOUND",
          `Command not found: ${this.deps.commandIds.from({ tool: target.toolName, command: target.commandName })}`,
          {
            tool: target.toolName,
            command: target.commandName,
            available: Object.keys(definition.commands),
          },
        );
      }
      return {
        tool: definition.name,
        command: target.commandName,
        path: loaded.path,
        ...this.commandMetadata({
          toolName: definition.name,
          name: target.commandName,
          command,
        }),
      };
    }

    return {
      name: definition.name,
      description: definition.description,
      path: loaded.path,
      commands: Object.entries(definition.commands).map(([name, command]) =>
        this.commandMetadata({ toolName: definition.name, name, command }),
      ),
    };
  }
}

export const ToolInspector = new ToolInspectorService();

export type ToolInspectorClass = {
  inspect(toolName: string, commandName?: string): ReturnType<ToolInspectorService["inspect"]>;
};

type ToolInspectorConstructor = {
  new (options?: ConfigOptions): ToolInspectorClass;
  readonly prototype: ToolInspectorClass;
};

type ToolInspectorAdapter = ToolInspectorClass & { readonly resource: ToolInspectorService };

const ToolInspectorClassAdapter = function constructToolInspector(
  this: ToolInspectorAdapter,
  options: ConfigOptions = {},
): void {
  Object.defineProperty(this, "resource", {
    value: new ToolInspectorService({ params: options, deps: ToolInspectorServiceDeps }),
  });
};
Object.defineProperty(ToolInspectorClassAdapter, "name", { value: "ToolInspectorClass" });
Object.defineProperty(ToolInspectorClassAdapter.prototype, "inspect", {
  configurable: true,
  value: function inspect(this: ToolInspectorAdapter, toolName: string, commandName?: string) {
    return this.resource.inspect({ toolName, commandName });
  },
  writable: true,
});

export const ToolInspectorClass = ToolInspectorClassAdapter as unknown as ToolInspectorConstructor;
