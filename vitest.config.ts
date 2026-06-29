import { defineConfig } from "vitest/config";

class VitestConfigFactory {
  static create() {
    return defineConfig({
      ssr: {
        external: ["typescript"],
      },
      test: {
        environment: "node",
        globals: false,
        include: ["tests/**/*.test.ts"],
        passWithNoTests: false,
        restoreMocks: true,
        testTimeout: 30_000,
        coverage: {
          provider: "v8",
          include: ["src/**/*.ts"],
          exclude: ["src/**/*.d.ts"],
          reporter: ["text", "json-summary"],
          thresholds: {
            100: true,
            perFile: true,
          },
        },
      },
    });
  }
}

export default VitestConfigFactory.create();
