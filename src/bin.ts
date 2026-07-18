#!/usr/bin/env bun
import { CliCompositionRootClass } from "./application/cli/composition-root";
import { isCliEntrypoint } from "./application/cli/runtime-bootstrap";

/* v8 ignore next 3 */
if (isCliEntrypoint(import.meta.url)) {
  await new CliCompositionRootClass({ metaUrl: import.meta.url, argv: process.argv }, {}).run();
}
