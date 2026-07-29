#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCliMain } from "./composition-root";

const entrypointPath = process.argv[1];
const isEntrypoint = Boolean(
  import.meta.main ||
  (entrypointPath &&
    existsSync(entrypointPath) &&
    import.meta.url === pathToFileURL(realpathSync(entrypointPath)).href),
);
/* v8 ignore next 3 */
if (isEntrypoint) {
  await runCliMain({ metaUrl: import.meta.url, argv: process.argv });
}
