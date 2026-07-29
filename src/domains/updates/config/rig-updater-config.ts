import { Context, Effect, Layer } from "effect";
import type { RigUpdaterParams } from "../types/updates";

export class RigUpdaterConfigService extends Context.Service<
  RigUpdaterConfigService,
  { readonly params: RigUpdaterParams }
>()("@rendotdev/rig/updates/RigUpdaterConfigService", {
  make: Effect.succeed({ params: { packageRoot: "", currentVersion: "" } }),
}) {
  static readonly layer = Layer.effect(RigUpdaterConfigService, RigUpdaterConfigService.make);
}
