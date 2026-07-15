export abstract class DomainClass<Params extends object, Deps extends object> {
  public constructor(
    protected readonly params: Readonly<Params>,
    protected readonly deps: Readonly<Deps>,
  ) {}
}
