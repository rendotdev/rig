import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { RigPathsConfigService, RigPathsService } from "../../../providers/paths/rig-paths";
import { AgentInstructionDocumentsService } from "../service/agent-instruction-documents";
import {
  AgentInstructionSyncLocations,
  type AgentInstructionTarget,
} from "../types/agent-instruction";

export class AgentInstructionTargetsConfigService extends Context.Service<
  AgentInstructionTargetsConfigService,
  { readonly cwd: string }
>()("@rendotdev/rig/generated/agent/AgentInstructionTargetsConfigService", {
  make: Effect.sync(() => ({ cwd: process.cwd() })),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionTargetsConfigService,
    AgentInstructionTargetsConfigService.make,
  );
}

class AgentInstructionProjectPathsService extends Context.Service<
  AgentInstructionProjectPathsService,
  {
    readonly instructionScope: (path: string) => Effect.Effect<AgentInstructionTarget["scope"]>;
    readonly projectDirectories: Effect.Effect<string[]>;
    readonly projectRoot: Effect.Effect<string>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionProjectPathsService", {
  make: Effect.gen(function* () {
    const pathConfig = yield* RigPathsConfigService;
    const { cwd } = yield* AgentInstructionTargetsConfigService;
    const isGitRoot = (directory: string): boolean => existsSync(join(directory, ".git"));
    const isPackageRoot = (directory: string): boolean =>
      existsSync(join(directory, "package.json"));
    const findProjectRoot = (directory: string): string => {
      let current = directory;
      let packageRoot: string | undefined;
      while (true) {
        if (isGitRoot(current)) return current;
        const foundFirstPackageRoot = !packageRoot && isPackageRoot(current);
        if (foundFirstPackageRoot) packageRoot = current;
        const parent = dirname(current);
        if (parent === current) return packageRoot ?? directory;
        current = parent;
      }
    };
    const projectRoot = Effect.sync(() => findProjectRoot(resolve(cwd))).pipe(
      Effect.withSpan("AgentInstructionProjectPathsService.projectRoot"),
    );
    const projectDirectories = Effect.sync(() => {
      const root = findProjectRoot(resolve(cwd));
      const directories: string[] = [];
      let current = resolve(cwd);
      while (true) {
        directories.push(current);
        if (current === root) return directories;
        current = dirname(current);
      }
    }).pipe(Effect.withSpan("AgentInstructionProjectPathsService.projectDirectories"));
    const instructionScope = Effect.fn("AgentInstructionProjectPathsService.instructionScope")(
      function* (path: string) {
        let current = dirname(path);
        const home = resolve(pathConfig.homeDir);
        while (true) {
          const isProjectBoundary = isGitRoot(current) || isPackageRoot(current);
          if (isProjectBoundary) return "visible";
          if (current === home) return "all";
          const parent = dirname(current);
          if (parent === current) return "visible";
          current = parent;
        }
      },
    );
    return { instructionScope, projectDirectories, projectRoot } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionProjectPathsService,
    AgentInstructionProjectPathsService.make,
  );
}

class AgentInstructionTargetCollectorService extends Context.Service<
  AgentInstructionTargetCollectorService,
  {
    readonly addClaudeDirectory: (
      targets: Map<string, AgentInstructionTarget>,
      directory: string,
      scope: AgentInstructionTarget["scope"],
    ) => Effect.Effect<void>;
    readonly addExistingFile: (
      targets: Map<string, AgentInstructionTarget>,
      path: string,
      scope: AgentInstructionTarget["scope"],
    ) => Effect.Effect<void>;
    readonly addOpenCodeConfig: (
      targets: Map<string, AgentInstructionTarget>,
      configPath: string,
    ) => Effect.Effect<void>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionTargetCollectorService", {
  make: Effect.gen(function* () {
    const documents = yield* AgentInstructionDocumentsService;
    const paths = yield* RigPathsService;
    const projectPaths = yield* AgentInstructionProjectPathsService;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Predicate.isObject(value) && !Array.isArray(value);
    const setTarget = Effect.fn("AgentInstructionTargetCollectorService.setTarget")(function* (
      targets: Map<string, AgentInstructionTarget>,
      target: AgentInstructionTarget,
    ) {
      const key = target.existed ? yield* documents.safeRealPath(target.path) : target.path;
      const current = targets.get(key);
      const scope = current?.scope === "all" || target.scope === "all" ? "all" : "visible";
      const shouldReplaceCurrent = !current || target.path < current.path;
      if (shouldReplaceCurrent) targets.set(key, { ...target, scope });
      else current.scope = scope;
    });
    const addExistingFile = Effect.fn("AgentInstructionTargetCollectorService.addExistingFile")(
      function* (
        targets: Map<string, AgentInstructionTarget>,
        path: string,
        scope: AgentInstructionTarget["scope"],
      ) {
        const isEligibleFile =
          (yield* documents.isFile(path)) && !(yield* documents.isIgnored(path));
        if (isEligibleFile) {
          yield* setTarget(targets, { path, existed: true, scope });
        }
      },
    );
    const addClaudeDirectory = Effect.fn(
      "AgentInstructionTargetCollectorService.addClaudeDirectory",
    )(function* (
      targets: Map<string, AgentInstructionTarget>,
      directory: string,
      scope: AgentInstructionTarget["scope"],
    ) {
      const path = join(directory, "CLAUDE.md");
      const existed = yield* documents.isFile(path);
      const isIgnoredExistingFile = existed && (yield* documents.isIgnored(path));
      if (isIgnoredExistingFile) return;
      const directoryExists = existed ? false : yield* documents.isDirectory(directory);
      const canCreateTarget = existed || directoryExists;
      if (canCreateTarget) yield* setTarget(targets, { path, existed, scope });
    });
    const addOpenCodeConfig = Effect.fn("AgentInstructionTargetCollectorService.addOpenCodeConfig")(
      function* (targets: Map<string, AgentInstructionTarget>, configPath: string) {
        const parsed = yield* documents.readText(configPath).pipe(
          Effect.map((source) => JSON.parse(source) as unknown),
          Effect.orElseSucceed(() => undefined),
        );
        const hasNoInstructionArray = !isRecord(parsed) || !Array.isArray(parsed.instructions);
        if (hasNoInstructionArray) return;
        const instructions = (parsed as { instructions: unknown[] }).instructions;
        yield* Effect.all(
          instructions.map((instruction) => {
            if (typeof instruction !== "string") return Effect.void;
            return Effect.gen(function* () {
              const targetPath =
                instruction === "~" || instruction.startsWith("~/")
                  ? yield* paths.resolve(instruction)
                  : isAbsolute(instruction)
                    ? instruction
                    : resolve(dirname(configPath), instruction);
              yield* addExistingFile(
                targets,
                targetPath,
                yield* projectPaths.instructionScope(targetPath),
              );
            });
          }),
          { concurrency: "unbounded" },
        );
      },
    );
    return { addClaudeDirectory, addExistingFile, addOpenCodeConfig } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionTargetCollectorService,
    AgentInstructionTargetCollectorService.make,
  );
}

export class AgentInstructionTargetsService extends Context.Service<
  AgentInstructionTargetsService,
  {
    readonly discover: Effect.Effect<AgentInstructionTarget[]>;
    readonly projectRoot: Effect.Effect<string>;
  }
>()("@rendotdev/rig/generated/agent/AgentInstructionTargetsService", {
  make: Effect.gen(function* () {
    const pathConfig = yield* RigPathsConfigService;
    const projectPaths = yield* AgentInstructionProjectPathsService;
    const collector = yield* AgentInstructionTargetCollectorService;
    const projectRoot = projectPaths.projectRoot.pipe(
      Effect.withSpan("AgentInstructionTargetsService.projectRoot"),
    );
    const discover = Effect.gen(function* () {
      const targets = new Map<string, AgentInstructionTarget>();
      yield* Effect.all(
        (yield* projectPaths.projectDirectories).flatMap((directory) => [
          ...AgentInstructionSyncLocations.projectFiles.map((file) =>
            collector.addExistingFile(targets, join(directory, file), "visible"),
          ),
          ...AgentInstructionSyncLocations.projectClaudeDirectories.map((name) =>
            collector.addClaudeDirectory(targets, join(directory, name), "visible"),
          ),
        ]),
        { concurrency: "unbounded" },
      );
      yield* Effect.all(
        [
          ...AgentInstructionSyncLocations.homeClaudeDirectories.map((path) =>
            collector.addClaudeDirectory(targets, join(pathConfig.homeDir, ...path), "all"),
          ),
          ...AgentInstructionSyncLocations.homeFiles.map((path) =>
            collector.addExistingFile(targets, join(pathConfig.homeDir, ...path), "all"),
          ),
          ...AgentInstructionSyncLocations.openCodeConfigFiles.map((path) =>
            collector.addOpenCodeConfig(targets, join(pathConfig.homeDir, ...path)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return [...targets.values()].toSorted((left, right) => left.path.localeCompare(right.path));
    }).pipe(Effect.withSpan("AgentInstructionTargetsService.discover"));
    return { discover, projectRoot } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    AgentInstructionTargetsService,
    AgentInstructionTargetsService.make,
  );
}

const agentInstructionTargetCollectorLayer = AgentInstructionTargetCollectorService.layer.pipe(
  Layer.provide(AgentInstructionProjectPathsService.layer),
);
export const agentInstructionTargetsLayer = AgentInstructionTargetsService.layer.pipe(
  Layer.provide(
    Layer.merge(AgentInstructionProjectPathsService.layer, agentInstructionTargetCollectorLayer),
  ),
);
