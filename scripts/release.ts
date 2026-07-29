import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { ReleaseService } from "./lib/release";

BunRuntime.runMain(
  ReleaseService.use((service) => service.run(Bun.argv.slice(2))).pipe(
    Effect.provide(ReleaseService.layer),
  ),
);
