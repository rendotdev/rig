import { defineConfig } from "vite-plus";

export default defineConfig({
  ssr: {
    external: ["typescript", "bun:sqlite"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
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
  pack: {
    entry: {
      rig: "src/cli.ts",
    },
    format: "esm",
    platform: "node",
    target: "node22",
    deps: {
      neverBundle: ["bun:sqlite"],
    },
    outDir: "dist",
    clean: true,
  },
});
