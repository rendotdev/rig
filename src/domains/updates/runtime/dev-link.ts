import { delimiter } from "node:path";
import { Context, Effect, Layer } from "effect";
import { RigError } from "../../../providers/errors/rig-error";
import { RigPathsConfigService, rigPathsConfigLayer } from "../../../providers/paths/rig-paths";
import { DevLinkConfigService } from "../config/dev-link-config";
import {
  DevLinkMutationService,
  devLinkOperationsLayer,
  DevLinkRenderService,
  DevLinkStateService,
} from "../service/dev-link";
import type { DevLinkCommandOptions, DevLinkStatus } from "../types/dev-link";

export class DevLinkService extends Context.Service<
  DevLinkService,
  {
    readonly link: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
    readonly unlink: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
    readonly status: (options?: DevLinkCommandOptions) => Effect.Effect<DevLinkStatus, RigError>;
    readonly renderLink: (status: DevLinkStatus) => Effect.Effect<string>;
    readonly renderUnlink: (status: DevLinkStatus) => Effect.Effect<string>;
  }
>()("@rendotdev/rig/updates/DevLinkService", {
  make: Effect.gen(function* () {
    const mutations = yield* DevLinkMutationService;
    const state = yield* DevLinkStateService;
    const renderer = yield* DevLinkRenderService;
    const link = Effect.fn("DevLinkService.link")(function* (options?: DevLinkCommandOptions) {
      return yield* mutations.link(options);
    });
    const unlink = Effect.fn("DevLinkService.unlink")(function* (options?: DevLinkCommandOptions) {
      return yield* mutations.unlink(options);
    });
    const status = Effect.fn("DevLinkService.status")(function* (options?: DevLinkCommandOptions) {
      return yield* state.status(options);
    });
    const renderLink = Effect.fn("DevLinkService.renderLink")(function* (value: DevLinkStatus) {
      return yield* renderer.renderLink(value);
    });
    const renderUnlink = Effect.fn("DevLinkService.renderUnlink")(function* (value: DevLinkStatus) {
      return yield* renderer.renderUnlink(value);
    });
    return { link, unlink, status, renderLink, renderUnlink } as const;
  }),
}) {
  static readonly layer = Layer.effect(DevLinkService, DevLinkService.make);
}

const devLinkConfigLayer = Layer.effect(
  DevLinkConfigService,
  Effect.gen(function* () {
    const paths = yield* RigPathsConfigService;
    const get = Effect.succeed({
      homeDir: paths.homeDir,
      repoRoot: process.cwd(),
      platform: process.platform,
      pathEnvironment: process.env.PATH ?? "",
      pathDelimiter: delimiter,
    } as const).pipe(Effect.withSpan("DevLinkConfigService.get"));
    return { get } as const;
  }),
).pipe(Layer.provide(rigPathsConfigLayer));

export const devLinkLayer = DevLinkService.layer.pipe(
  Layer.provide(devLinkOperationsLayer),
  Layer.provide(devLinkConfigLayer),
);
