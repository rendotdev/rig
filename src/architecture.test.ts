import { describe, expect, it } from "vite-plus/test";
import { readFile, readdir } from "node:fs/promises";

class ArchitectureSourceSetClass {
  async implementationFiles(): Promise<string[]> {
    const files = await Promise.all(
      ["src", "scripts"].map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter(
            (path) =>
              (path.endsWith(".ts") || path.endsWith(".tsx")) &&
              !path.endsWith(".test.ts") &&
              !path.endsWith(".test.tsx") &&
              !path.endsWith(".d.ts"),
          )
          .map((path) => `${root}/${path}`),
      ),
    );
    return files.flat().toSorted();
  }

  async violations(
    pattern: RegExp,
    validate: (match: RegExpMatchArray) => boolean,
  ): Promise<string[]> {
    const files = await this.implementationFiles();
    const violations = await Promise.all(
      files.map(async (path) => {
        const source = await readFile(path, "utf8");
        return [...source.matchAll(pattern)]
          .filter((match) => !validate(match))
          .map((match) => `${path}:${this.line(source, match.index)}`);
      }),
    );
    return violations.flat();
  }

  private line(source: string, index: number | undefined): number {
    return source.slice(0, index ?? 0).split("\n").length;
  }
}

describe("architecture", () => {
  const sources = new ArchitectureSourceSetClass();

  it("uses architectural suffixes for implementation class declarations", async () => {
    const violations = await sources.violations(
      /\bclass\s+([A-Za-z_$][\w$]*)([\s\S]*?)(?=\{)/g,
      (match) =>
        /(?:Class|Config|Error|Repo|Repository|Service|Runtime|Provider|Route)$/.test(match[1]!) ||
        /extends\s+(?:Context\.Service|Schema\.(?:Class|ErrorClass|TaggedClass|TaggedErrorClass))/.test(
          match[0],
        ),
    );
    expect(violations).toEqual([]);
  });

  it("keeps behavior on instances instead of static methods", async () => {
    const violations = await sources.violations(/\bstatic\s+[A-Za-z_$][\w$]*\s*[<(]/g, () => false);
    expect(violations).toEqual([]);
  });

  it("uses definitions for migrated application behavior", async () => {
    const migratedDefinitions = [
      {
        path: "src/application/cli/composition-root.ts",
        names: ["CliCompositionRootService"],
      },
      {
        path: "src/application/cli/runtime-bootstrap.ts",
        names: ["BunRuntimeBootstrapService", "CliEntrypointService"],
      },
      {
        path: "src/application/cli/command-ui.tsx",
        names: ["CommandUiComponent", "CommandUiRendererService"],
      },
      {
        path: "src/cron/application/rig-cron.ts",
        names: ["RigCronService", "RigCronWorkerService", "CronStateTransactionService"],
      },
      {
        path: "src/runtime/updates/rig-updater.ts",
        names: ["RigUpdateCommandRunnerService", "RigUpdaterService", "RigUpdaterFactoryService"],
      },
      {
        path: "src/runtime/updates/npm-update-check.ts",
        names: ["NpmUpdateCheckService", "VersionComparatorSingleton"],
      },
    ];

    const sourcesByEntry = await Promise.all(
      migratedDefinitions.map(async (entry) => ({
        entry,
        source: await readFile(entry.path, "utf8"),
      })),
    );

    for (const { entry, source } of sourcesByEntry) {
      expect(source).not.toContain("DomainClass");
      for (const name of entry.names) {
        expect(source).toContain(name);
        expect(source).not.toContain(`${name}Builder`);
      }
    }
  });

  it("uses Effect services and layers at reliability boundaries", async () => {
    const paths = [
      "src/config/application/config-effect-service.ts",
      "src/cron/application/rig-cron-effect-service.ts",
      "src/domains/settings/repo/file-lock.ts",
      "src/runtime/process/rig-shell-service.ts",
      "src/runtime/updates/rig-updater-effect-service.ts",
      "src/tools/execution/tool-execution-resources.ts",
    ];
    const sourcesByPath = await Promise.all(
      paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    );
    for (const { source } of sourcesByPath) {
      expect(source).toContain("extends Context.Service");
      expect(source).toContain("makeLayer");
      expect(source).toContain("Schema.TaggedErrorClass");
    }

    const updateCheck = await readFile("src/runtime/updates/npm-update-check.ts", "utf8");
    expect(updateCheck).toContain("Schema.TaggedErrorClass");
    expect(updateCheck).toContain("Effect.retry");
    expect(updateCheck).toContain("Schedule.exponential");
  });

  it("has no legacy define construction vocabulary", async () => {
    const importingFiles = (
      await Promise.all(
        (
          await sources.implementationFiles()
        ).map(async (path) => ({
          path,
          source: await readFile(path, "utf8"),
        })),
      )
    )
      .filter(({ source }) => /from\s+["'][^"']*define["']/.test(source))
      .map(({ path }) => path);

    expect(importingFiles).toEqual([]);
    expect(await readdir("src")).not.toContain("define.ts");
  });

  it("keeps vendored source as a read-only reference", async () => {
    const violations = await sources.violations(
      /(?:from\s+|import\s*)["']([^"']*repos\/effect[^"']*)["']/g,
      () => false,
    );
    expect(violations).toEqual([]);
  });

  it("keeps persistence independent from CLI application modules", async () => {
    const persistenceFiles = (await sources.implementationFiles()).filter((entry) =>
      entry.startsWith("src/persistence/"),
    );
    const violations = (
      await Promise.all(
        persistenceFiles.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
      )
    )
      .filter(({ source }) => /from\s+["'][^"']*(?:application\/cli|\/cli)[^"']*["']/.test(source))
      .map(({ path }) => path);
    expect(violations).toEqual([]);
  });
});
