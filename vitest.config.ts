import { defineConfig } from "vitest/config";

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
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
