#!/usr/bin/env bun
import { CliCompositionRootClass } from "./application/cli/composition-root";
import { isCliEntrypoint } from "./application/cli/runtime-bootstrap";

export {
  CliApplicationClass,
  CliApplicationClass as CliApplication,
} from "./application/cli/cli-application";
export {
  BunRuntimeBootstrapClass,
  BunRuntimeBootstrapClass as BunRuntimeBootstrap,
  isCliEntrypoint,
} from "./application/cli/runtime-bootstrap";
export { RigCronWorkerClass, RigCronWorkerClass as RigCronWorker } from "./tools/cron";

/* v8 ignore next 3 */
if (isCliEntrypoint(import.meta.url)) {
  await new CliCompositionRootClass({ metaUrl: import.meta.url, argv: process.argv }, {}).run();
}
