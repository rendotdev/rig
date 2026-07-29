# AGENTS.md

- Never commit or push unless asked for.
- Put production behavior in `Context.Service`; do not add floating functions, classes, clients, factories, or singletons.
- For scripts, use `Bun.file(...).text()` or `Bun.file(...).json()` for reads.
- For script writes, use `Bun.write(...)`; reserve `node:fs/promises` for application adapters.
- Keep `./src/agents/instructions.ts`, the README.md "Agent?" section, and this file's instructions block in sync when editing any of them.

## Effect reference

- Run `vp run effect:reference` when `repos/effect/LLMS.md` is missing before writing Effect code.
- Read `repos/effect/LLMS.md`, then use `repos/effect` as read-only reference material.
- Import Effect from package dependencies; never import application code from `repos/effect`.
- Import Effect APIs as named imports from `effect`; do not use deep Effect imports.
- Keep private pure helpers as local const arrows inside a service `make`.
- Keep private effectful helpers as named `Effect.fn("Service.method")(function* (...) {})` values.
- Return public operations from the service `make` as a readonly object using `as const`.
- Keep `ConfigService` APIs data-only; move callable behavior to a capability or platform service.
- Export production layers with descriptive names ending in `Layer`; close internal dependencies in the layer graph.
- Model recoverable operational failures with `Schema.TaggedErrorClass` names ending in `Error`.
- Use `Effect.acquireRelease`, scoped layers, retries, and schedules at the reliability seams that need them.
- Keep `Effect.run*` and `ManagedRuntime` calls at approved application, script, or compatibility boundaries.
- Keep existing focused libraries behind Effect service adapters instead of replacing them.
- Do not create barrel files; import from the module that owns each symbol.
