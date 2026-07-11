import { defineConfig } from "vite-plus";

export default defineConfig({
  ssr: {
    external: ["typescript", "bun:sqlite"],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/tools/collection-memory-index.ts",
        "src/tools/collection.ts",
        "src/tools/help-topics.ts",
      ],
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
