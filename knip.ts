/// <reference types="@types/bun" />

import type { KnipConfig } from "knip";

const effectReferenceManifest = new URL("./repos/effect/package.json", import.meta.url);
const effectReferenceExists = await Bun.file(effectReferenceManifest).exists();
const ignoredReferenceFiles = effectReferenceExists ? ["repos/**"] : [];

export default {
  entry: [
    "src/app/cli/entrypoint.ts",
    "src/app/cli/module-entrypoint.ts",
    "src/tooling/oxlint/oxlint-plugin.ts",
    "src/**/*.test.{ts,tsx}",
    "scripts/**/*.test.ts",
    "test/domains/**/*.test.ts",
    "test/e2e/**/*.e2e.test.ts",
    "test/e2e/fixtures/**/*.ts",
  ],
  project: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "test/**/*.ts"],
  ignore: ignoredReferenceFiles,
  ignoreDependencies: ["@effect/language-service", "@effect/tsgo", "vite"],
  ignoreUnresolved: ["bun-types"],
  ignoreIssues: {
    "src/domains/tools/runtime/tool-sdk.ts": ["exports", "types"],
  },
} satisfies KnipConfig;
