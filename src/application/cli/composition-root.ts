import { defineService } from "../../define";
import { CliApplicationClass } from "./cli-application";
import { BunRuntimeBootstrapClass } from "./runtime-bootstrap";

export type CliCompositionRootParams = {
  metaUrl: string;
  argv: string[];
};

export type CliCompositionRootDeps = {
  application?: Pick<CliApplicationClass, "run">;
  runtimeBootstrap?: Pick<BunRuntimeBootstrapClass, "run">;
  exit?: (code: number) => never;
};

type CliCompositionRootServiceDeps = {
  runApplication: (params: { argv: string[] }) => Promise<void>;
  runRuntimeBootstrap: (params: { metaUrl: string; argv: string[] }) => number | undefined;
  exit: (code: number) => never;
};

const CliCompositionRootProductionDeps: CliCompositionRootServiceDeps = {
  runApplication: async function runApplication(params: { argv: string[] }) {
    await new CliApplicationClass().run(params.argv);
  },
  runRuntimeBootstrap: function runRuntimeBootstrap(params: { metaUrl: string; argv: string[] }) {
    return new BunRuntimeBootstrapClass({}, {}).run(params);
  },
  exit: process.exit.bind(process),
};

export class CliCompositionRootService extends defineService({
  params: { metaUrl: "", argv: [] } as CliCompositionRootParams,
  deps: CliCompositionRootProductionDeps,
}) {
  public async run(_params: {}): Promise<void> {
    const bootstrapped = this.deps.runRuntimeBootstrap({
      metaUrl: this.params.metaUrl,
      argv: this.params.argv,
    });
    if (bootstrapped !== undefined) this.deps.exit(bootstrapped);
    await this.deps.runApplication({ argv: this.params.argv });
  }
}

export const CliCompositionRoot = new CliCompositionRootService();

export type CliCompositionRootClass = {
  run(): Promise<void>;
};

type CliCompositionRootConstructor = {
  new (params: CliCompositionRootParams, deps: CliCompositionRootDeps): CliCompositionRootClass;
  readonly prototype: CliCompositionRootClass;
};

type CliCompositionRootAdapter = CliCompositionRootClass & {
  readonly resource: CliCompositionRootService;
};

const CliCompositionRootClassAdapter = function constructCliCompositionRoot(
  this: CliCompositionRootAdapter,
  params: CliCompositionRootParams,
  deps: CliCompositionRootDeps,
): void {
  const application = deps.application;
  const runtimeBootstrap = deps.runtimeBootstrap;
  Object.defineProperty(this, "resource", {
    value: new CliCompositionRootService({
      params,
      deps: {
        runApplication: application
          ? async function runApplication(runParams: { argv: string[] }) {
              await application.run(runParams.argv);
            }
          : CliCompositionRootProductionDeps.runApplication,
        runRuntimeBootstrap: runtimeBootstrap
          ? function runRuntimeBootstrap(runParams: { metaUrl: string; argv: string[] }) {
              return runtimeBootstrap.run(runParams);
            }
          : CliCompositionRootProductionDeps.runRuntimeBootstrap,
        exit: deps.exit ?? CliCompositionRootProductionDeps.exit,
      },
    }),
  });
};
Object.defineProperty(CliCompositionRootClassAdapter, "name", {
  value: "CliCompositionRootClass",
});
Object.defineProperty(CliCompositionRootClassAdapter.prototype, "run", {
  configurable: true,
  value: function run(this: CliCompositionRootAdapter) {
    return this.resource.run({});
  },
  writable: true,
});

export const CliCompositionRootClass =
  CliCompositionRootClassAdapter as unknown as CliCompositionRootConstructor;
