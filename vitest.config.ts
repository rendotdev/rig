import { defineConfig } from "vitest/config";

class VitestConfigFactory {
  static create() {
    return defineConfig({
      test: {
        environment: "node",
        globals: false,
        include: ["tests/**/*.test.ts"],
        passWithNoTests: false,
        restoreMocks: true,
        testTimeout: 30_000,
      },
    });
  }
}

export default VitestConfigFactory.create();
