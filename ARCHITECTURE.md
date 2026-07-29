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

Only create a layer directory when the domain has code for it. Every service and type is exported
from the concrete module that owns it. Cross-domain and app imports name that module directly.

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

## Domain dependency graph

Domain edges are explicit and acyclic. A domain may depend only on the domains declared here:

| Domain        | Allowed domain dependencies           |
| ------------- | ------------------------------------- |
| `collections` | none                                  |
| `registry`    | `settings`                            |
| `scheduling`  | `settings`, `tools`                   |
| `settings`    | none                                  |
| `tools`       | `collections`, `registry`, `settings` |
| `updates`     | `settings`                            |

Across an allowed domain edge, code imports only `types`, `service`, or `runtime` contracts at
the same or an earlier layer. Config and repository implementations remain private to their
owning domain. The architecture model rejects undeclared edges even when they would be acyclic.

## Effect v4 reliability harness

Rig keeps its existing libraries and uses Effect v4 as the internal orchestration harness. Effect
owns dependency composition, typed operational failures, resource lifetimes, cancellation,
retries, schedules, and tracing. Commander, Ink, Zod, Bun SQLite, and other focused libraries stay
in place behind Effect services when they already solve their responsibility well.

- Model capabilities with `Context.Service`; use stable `@rendotdev/rig/...` service identities.
- Export production implementations with descriptive camel-case names ending in `Layer`.
- Name alternatives `testLayer`, `bunLayer`, `sqliteLayer`, or another role-specific `Layer` name.
- Model recoverable operational failures with `Schema.TaggedErrorClass` and an `Error` suffix.
- Use `Schema.Class` and branded schemas for domain entities and value objects when migrating them.
- Use `Effect.acquireRelease`, `Layer.scoped`, or `Scope` for every owned closeable resource.
- Capture service dependencies while constructing the layer; service methods do not leak them.
- Run Effects at application or compatibility boundaries; do not call `Effect.run*` inside Effects.
- Adapt existing Promise and Zod APIs at the boundary instead of forcing downstream tools to move.
- Retry only transient, idempotent operations; cap attempts and use an explicit `Schedule` policy.
- Preserve the final failure cause when retries are exhausted and record retry attempts in spans.
- Keep private pure transformations as local const arrows inside their owning service `make`.
- Keep React rendering and the public Zod SDK compatible while services own their supporting behavior.

The pinned Effect source lives under `repos/effect` as a shallow, read-only git submodule. Run
`vp run effect:reference` when it is missing from a fresh checkout. Production code imports the
installed `effect` packages, never files under `repos/effect`. Agents should read the referenced
`LLMS.md`, patterns, source, and tests before relying on remembered APIs.

## Dependency rules

Within a domain, a layer may import itself and the layers listed below:

| Source    | Allowed targets                                               |
| --------- | ------------------------------------------------------------- |
| `types`   | `types`, `utils`                                              |
| `config`  | `types`, `config`, `utils`                                    |
| `repo`    | `types`, `config`, `repo`, `providers`, `utils`               |
| `service` | `types`, `config`, `repo`, `service`, `providers`, `utils`    |
| `runtime` | `types`, `config`, `service`, `runtime`, `providers`, `utils` |
| `ui`      | `types`, `config`, `service`, `runtime`, `ui`, `utils`        |

Additional rules:

- Import cross-domain symbols from the module that owns them; barrel files are forbidden.
- `app` imports domain types, services, runtimes, UI, providers, and utilities.
- Close config and repo dependencies inside exported domain layers before app wiring consumes them.
- Providers import only providers, utilities, and external packages.
- Utilities import only utilities and external packages.
- Tooling imports only tooling, utilities, and external packages.
- Domains and providers never import `app`.
- Production code never imports `tooling`.
- Domain `repo`, `service`, and `runtime` layers may use Providers; types, config, and UI may not.
- Every production module must classify under this model; there is no legacy source escape hatch.

`src/tooling/architecture/architecture.ts` is the executable source of truth. Custom Oxlint
rules and structural tests consume the same model.

## Mechanical enforcement

- `src/tooling/architecture/architecture.ts` owns the layer and domain matrices.
- Oxlint rejects invalid source locations and dependency edges with concrete remediation.
- Structural tests parse every production import with the TypeScript AST and validate the real graph.
- CI runs architecture lint, structural tests, Effect diagnostics, dead-code analysis, and behavior tests.
- Human review feedback becomes a documented invariant or a mechanical rule when it can recur.

## Taste invariants

- Production files contain at most 400 meaningful lines.
- Test files contain at most 600 meaningful lines.
- Functions and methods contain at most 80 meaningful lines.
- Blank and comment-only lines do not count toward these limits.
- Split by responsibility and layer; avoid generic helper buckets.
- Assign compound `if` conditions to descriptive boolean constants.
- Boundary diagnostics include concrete remediation for the next agent run.
