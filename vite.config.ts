import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      typecheck: {
        command: "tsc --noEmit",
        input: [
          "src/**",
          "scripts/**",
          "test/**",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
        ],
        output: [],
      },
      check: {
        command: "vp check",
        dependsOn: ["typecheck"],
        input: [
          "src/**",
          "scripts/**",
          "test/**",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
        ],
        output: [],
      },
      build: {
        command: "vp pack",
        input: ["src/**", "package.json", "tsconfig.json", "vite.config.ts", "bun.lock"],
        output: ["dist/**"],
      },
      test: {
        command: "vp test run src scripts --coverage",
        dependsOn: ["check"],
        input: ["src/**", "scripts/**", "package.json", "tsconfig.json", "vite.config.ts"],
        output: ["coverage/**"],
      },
      "test:e2e": {
        command: "vp test run test/e2e --coverage.enabled=false",
        dependsOn: ["build"],
        input: ["test/e2e/**", "package.json", "tsconfig.json", "vite.config.ts"],
        output: [],
      },
      smoke: {
        command: "bun run scripts/smoke.ts",
        dependsOn: ["build"],
        input: ["dist/**", "scripts/smoke.ts", "scripts/lib/smoke.ts"],
        output: [],
      },
      "package:check": {
        command: "npm pack --dry-run --ignore-scripts",
        dependsOn: ["build"],
        input: ["dist/**", "package.json", "README.md", "LICENSE"],
        output: [],
      },
      validate: {
        command: "bun -e \"console.log('Validation complete.')\"",
        dependsOn: ["test", "test:e2e", "smoke"],
        output: [],
      },
      ci: {
        command: "bun -e \"console.log('CI validation complete.')\"",
        dependsOn: ["validate", "package:check"],
        output: [],
      },
      bench: {
        command: "bun run scripts/bench.ts",
        dependsOn: ["build"],
        cache: false,
      },
      release: {
        command: "bun run scripts/release.ts",
        cache: false,
      },
      "release:beta": {
        command: "bun run scripts/release.ts beta",
        cache: false,
      },
      "release:dry-run": {
        command: "bun run scripts/release.ts --dry-run",
        cache: false,
      },
      "release:major": {
        command: "bun run scripts/release.ts major",
        cache: false,
      },
      "release:minor": {
        command: "bun run scripts/release.ts minor",
        cache: false,
      },
      "release:patch": {
        command: "bun run scripts/release.ts patch",
        cache: false,
      },
      dev: {
        command: "vp pack --watch",
        cache: false,
      },
      format: {
        command: "vp fmt",
        cache: false,
      },
      lint: {
        command: "vp lint --deny-warnings",
        input: [
          "src/**",
          "scripts/**",
          "test/**",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
        ],
        output: [],
      },
      "test:watch": {
        command: "vp test watch",
        cache: false,
      },
    },
  },
  pack: {
    deps: {
      neverBundle: ["ink", "react", "typescript", /^bun:/],
      onlyBundle: false,
    },
    entry: { rig: "src/cli.ts" },
    format: "esm",
    outDir: "dist",
    platform: "node",
    target: "node20",
  },
  ssr: {
    external: ["typescript", "bun:sqlite"],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "test/e2e/**/*.e2e.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.{ts,tsx}", "src/tools/presentation/help-topics.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    insertFinalNewline: true,
    sortPackageJson: true,
    ignorePatterns: ["AGENTS.md", "dist/**", "coverage/**", "node_modules/**"],
  },
  lint: {
    env: {
      builtin: true,
      node: true,
      vitest: true,
    },
    plugins: ["typescript", "unicorn", "promise", "node", "vitest"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "typescript/no-base-to-string": "off",
      "typescript/no-extraneous-class": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    ignorePatterns: ["dist/**", "coverage/**", "node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
