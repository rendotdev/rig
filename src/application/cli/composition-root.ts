import { CliApplicationClass } from "./cli-application";
import { BunRuntimeBootstrapClass } from "./runtime-bootstrap";

export type CliCompositionRootParams = {
  metaUrl: string;
  argv: string[];
};

export type CliCompositionRootDeps = {
  application?: CliApplicationClass;
  runtimeBootstrap?: BunRuntimeBootstrapClass;
  exit?: (code: number) => never;
};

export class CliCompositionRootClass {
  private readonly application: CliApplicationClass;
  private readonly runtimeBootstrap: BunRuntimeBootstrapClass;
  private readonly exit: (code: number) => never;

  constructor(
    private readonly params: CliCompositionRootParams,
    deps: CliCompositionRootDeps = {},
  ) {
    this.application = deps.application ?? new CliApplicationClass();
    this.runtimeBootstrap = deps.runtimeBootstrap ?? new BunRuntimeBootstrapClass();
    this.exit = deps.exit ?? process.exit;
  }

  async run(): Promise<void> {
    const bootstrapped = this.runtimeBootstrap.run(this.params.metaUrl, this.params.argv);
    if (bootstrapped !== undefined) this.exit(bootstrapped);
    await this.application.run(this.params.argv);
  }
}
