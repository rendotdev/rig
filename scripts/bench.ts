import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { RigBenchmarkService } from "./lib/benchmark";

BunRuntime.runMain(
  RigBenchmarkService.use((service) => service.run).pipe(Effect.provide(RigBenchmarkService.layer)),
);
