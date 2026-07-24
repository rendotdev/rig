# Rig definition migration plan

## Goal

Align Rig's construction vocabulary with lgtm's `src/define.ts` while preserving CLI behavior,
tool runtime compatibility, generated files, state transitions, and full test coverage.

## Shared contract

Rig and lgtm keep identical `src/define.ts` and `src/define.test.ts` files.

- `defineType`, `defineConfig`, and `defineUtil` preserve named data-only values.
- `defineRepo`, `defineService`, `defineRuntime`, and `defineProvider` create base classes.
- `defineSingleton` defines intentional shared behavior inline.
- `defineUIComponent` and `defineUIHook` keep UI implementations inline.
- `defineApp` executes a composition root with `params` and `deps` available through `this`.

## Migration rules

1. Replace generated `*Builder` exports with direct classes or inline definitions.
2. Rename construction `config` to `params`.
3. Access stable parameters and replaceable dependencies through `this.params` and `this.deps`.
4. Replace dependencies through class constructor props in tests.
5. Give public methods one named `params` object.
6. Keep production dependencies explicit beside each definition.
7. Keep singleton, component, hook, and app implementations inside their definition calls.
8. Use the helper matching the owning architectural layer.
9. Preserve documented Rig tool and CLI contracts at their boundaries.
10. Keep type-only declarations as plain TypeScript.

## Naming

- Name repository classes `*Repo` or `*Repository`.
- Name service classes `*Service`.
- Name runtime classes for the process they own.
- Name provider classes `*Provider`.
- Name components `*Component` or `*Route` and hooks `use*`.
- Give intentional production instances a concise domain name.

## Verification

Run:

```text
vp check
vp test --run
vp run build:package
node dist/bin.mjs --version
node dist/rig.mjs --version
```

Also verify:

```text
cmp src/define.ts ../lgtm/src/define.ts
rg -n "DefinitionType|defineDeps|[A-Za-z0-9_]+Builder" src scripts
```

Builder matches for Rig's public fluent argument API are expected. Definition builders are not.

## Completion criteria

- Rig and lgtm expose the same definition API.
- Reusable behavior uses the helper for its architectural layer.
- Generated definition builders are absent.
- Tests replace class `params` and `deps` through constructors.
- Generated runtime contracts and CLI outputs remain compatible.
- Formatting, typing, tests, package builds, and human review pass.
