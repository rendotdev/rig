import { CliApplicationClass } from "./cli-application";
import { BunRuntimeBootstrapClass } from "./runtime-bootstrap";
import { DomainClass } from "../../domain/domain-class";

export type CliCompositionRootParams = {
  metaUrl: string;
  argv: string[];
};

export type CliCompositionRootDeps = {
  application?: CliApplicationClass;
  runtimeBootstrap?: BunRuntimeBootstrapClass;
  exit?: (code: number) => never;
};

export class CliCompositionRootClass extends DomainClass<
  CliCompositionRootParams,
  CliCompositionRootDeps
> {
  private readonly application: CliApplicationClass;
  private readonly runtimeBootstrap: BunRuntimeBootstrapClass;
  private readonly exit: (code: number) => never;

  public constructor(params: CliCompositionRootParams, deps: CliCompositionRootDeps) {
    super(params, deps);
    this.application = this.deps.application ?? new CliApplicationClass();
    this.runtimeBootstrap = this.deps.runtimeBootstrap ?? new BunRuntimeBootstrapClass({}, {});
    this.exit = this.deps.exit ?? process.exit;
  }

  public async run(): Promise<void> {
    const bootstrapped = this.runtimeBootstrap.run({
      metaUrl: this.params.metaUrl,
      argv: this.params.argv,
    });
    if (bootstrapped !== undefined) this.exit(bootstrapped);
    await this.application.run(this.params.argv);
  }
}
