# Architecture

Rig uses layered business domains with mechanically enforced dependency boundaries. The
filesystem is the architecture map. Put code in the domain and layer that owns its behavior,
then let Oxlint verify every dependency edge.

## Target source layout

```text
src/
  app/
    cli/
  domains/
    collections/
    registry/
    scheduling/
    settings/
    tools/
    updates/
  providers/
  tooling/
  utils/
```

Each domain may contain these layers:

```text
types -> config -> repo -> service -> runtime -> ui
```

Only create a layer directory when the domain has code for it. Every domain exposes a
deliberate public API from `index.ts`. Cross-domain and app imports use that API instead of
importing domain internals.

## Domain ownership

| Domain        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `collections` | Collection contracts, field paths, indexes, and document persistence  |
| `registry`    | Tool discovery, registry configuration, and registered tool metadata  |
| `scheduling`  | Cron definitions, scheduling state, workers, and cron lifecycle       |
| `settings`    | Rig configuration, paths, locking, and configuration migration        |
| `tools`       | Tool SDK, loading, execution, management, migration, and presentation |
| `updates`     | Version discovery, update decisions, and update execution             |

## Layer responsibilities

| Layer     | Responsibility                                                                    |
| --------- | --------------------------------------------------------------------------------- |
| `types`   | Data contracts, schemas, parsers, discriminated unions, and data-shaped errors    |
| `config`  | Defaults, constants, static policies, and supported values                        |
| `repo`    | Persistence, filesystem acquisition, serialization, and external data access      |
| `service` | Stateless use cases, domain transformations, and business rules                   |
| `runtime` | Stateful orchestration, processes, timers, caches, workers, and long-running work |
| `ui`      | Ink components, hooks, view mapping, and presentation behavior                    |

Top-level responsibilities:

| Location    | Responsibility                                                                  |
| ----------- | ------------------------------------------------------------------------------- |
| `app`       | CLI composition, boundary parsing, dependency wiring, and result translation    |
| `providers` | Domain-independent process, filesystem, clock, environment, and terminal access |
| `utils`     | Pure domain-independent code with at least two real consumers                   |
| `tooling`   | Architecture enforcement and development tooling                                |

External data is parsed at `repo`, `runtime`, or `app` boundaries before it enters domain
behavior. Keep Rig's public SDK Promise-based and Zod-based while internal architecture moves.

## Effect v4 reliability harness

Rig keeps its existing libraries and uses Effect v4 as the internal orchestration harness. Effect
owns dependency composition, typed operational failures, resource lifetimes, cancellation,
retries, schedules, and tracing. Commander, Ink, Zod, Bun SQLite, and other focused libraries stay
in place behind Effect services when they already solve their responsibility well.

- Model capabilities with `Context.Service`; use stable `@rendotdev/rig/...` service identities.
- Expose the production implementation as `layer`; name alternatives `testLayer`, `bunLayer`,
  `sqliteLayer`, or another camel-case name ending in `Layer`.
- Model recoverable operational failures with `Schema.TaggedErrorClass` and an `Error` suffix.
- Use `Schema.Class` and branded schemas for domain entities and value objects when migrating them.
- Use `Effect.acquireRelease`, `Layer.scoped`, or `Scope` for every owned closeable resource.
- Capture service dependencies while constructing the layer; service methods do not leak them.
- Run Effects at application or compatibility boundaries; do not call `Effect.run*` inside Effects.
- Adapt existing Promise and Zod APIs at the boundary instead of forcing downstream tools to move.
- Retry only transient, idempotent operations; cap attempts and use an explicit `Schedule` policy.
- Preserve the final failure cause when retries are exhausted and record retry attempts in spans.
- Keep pure transformations, React components, and Zod authoring APIs free of unnecessary Effect.

The pinned Effect source will live under `repos/effect` as a read-only git subtree. Production code
imports the installed `effect` packages, never files under `repos/effect`. Agents should read the
vendored `LLMS.md`, patterns, source, and tests before relying on remembered APIs.

## Dependency rules

Within a domain, a layer may import itself and the layers listed below:

| Source    | Allowed targets                                                     |
| --------- | ------------------------------------------------------------------- |
| `types`   | `types`, `utils`                                                    |
| `config`  | `types`, `config`, `utils`                                          |
| `repo`    | `types`, `config`, `repo`, `providers`, `utils`                     |
| `service` | `types`, `config`, `repo`, `service`, `providers`, `utils`          |
| `runtime` | `types`, `config`, `service`, `runtime`, `providers`, `utils`       |
| `ui`      | `types`, `config`, `service`, `runtime`, `ui`, `providers`, `utils` |

Additional rules:

- Cross-domain imports use `domains/<domain>/index.ts` or a deliberate layer `index.ts`.
- `app` imports domain public APIs, providers, and utilities.
- Providers import only providers, utilities, and external packages.
- Utilities import only utilities and external packages.
- Tooling imports only tooling, utilities, and external packages.
- Domains and providers never import `app`.
- Production code never imports `tooling`.
- Migrated code cannot import a legacy source root.
- Legacy code may import migrated public APIs while its vertical is being moved.

`src/tooling/architecture/architecture.ts` is the executable source of truth. Custom Oxlint
rules and structural tests consume the same model.

## Migration sequence

Rig currently has legacy roots listed in the shared architecture model. They are temporary,
explicit migration allowances rather than permanent exceptions.

1. Move one business capability into `domains/<domain>/<layer>`.
2. Add the domain or layer public `index.ts`.
3. Update outside consumers to use the public API.
4. Use `Context.Service`, `Layer`, or plain TypeScript according to the capability.
5. Remove the migrated legacy root or narrow its allowance.
6. Run `vp run ci` before moving the next high-risk runtime seam.

## Taste invariants

- Production files contain at most 400 meaningful lines.
- Test files contain at most 600 meaningful lines.
- Functions and methods contain at most 80 meaningful lines.
- Blank and comment-only lines do not count toward these limits.
- Existing oversized files use exact migration ceilings and cannot grow.
- Migration ceilings shrink or disappear as each file is split.
- Split by responsibility and layer; avoid generic helper buckets.
- Boundary diagnostics include concrete remediation for the next agent run.
