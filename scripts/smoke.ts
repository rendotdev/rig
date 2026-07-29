import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { SmokeScriptService } from "./lib/smoke";

BunRuntime.runMain(
  SmokeScriptService.use((service) => service.run).pipe(Effect.provide(SmokeScriptService.layer)),
);
