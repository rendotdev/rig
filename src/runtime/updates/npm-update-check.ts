import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineService, defineSingleton } from "../../define";
import { RigPathsClass, type PathOptions } from "../../config/paths";

export type UpdateCheckNotice = {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  message: string;
};

type UpdateCheckCache = {
  checkedAt: number;
  latestVersion?: string;
};

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type UpdateCheckOptions = PathOptions & {
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetch?: FetchLike;
  packageName?: string;
};

function versionParts(params: { version: string }): number[] {
  return params.version
    .replace(/^v/, "")
    .split(/[.-]/)
    .map(function parseVersionPart(part) {
      return Number.parseInt(part, 10);
    })
    .filter(function keepFinitePart(part) {
      return Number.isFinite(part);
    });
}

export const VersionComparatorSingleton = defineSingleton({
  params: {},
  deps: {},
  isNewer(params: { candidate: string; current: string }): boolean {
    function compare(compareParams: { left: string; right: string }): number {
      const leftParts = versionParts({ version: compareParams.left });
      const rightParts = versionParts({ version: compareParams.right });
      const length = Math.max(leftParts.length, rightParts.length);

      for (let index = 0; index < length; index++) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;
        if (leftPart > rightPart) return 1;
        if (leftPart < rightPart) return -1;
      }

      return 0;
    }

    return compare({ left: params.candidate, right: params.current }) > 0;
  },
});

type NpmUpdateCheckConfig = {
  updateCheckCachePath: string;
  cacheTtlMs: number;
  timeoutMs: number;
  packageName: string;
};

type NpmUpdateCheckDeps = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  fetch: FetchLike;
  mkdir: typeof mkdir;
  dirname: typeof dirname;
  readJson: (path: string) => Promise<unknown>;
  writeText: (path: string, content: string) => Promise<void>;
  createAbortController: () => AbortController;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

const NpmUpdateCheckProductionDeps: NpmUpdateCheckDeps = {
  env: process.env,
  now: Date.now,
  fetch,
  mkdir,
  dirname,
  async readJson(path) {
    /* v8 ignore next 3 */
    return typeof Bun !== "undefined"
      ? await Bun.file(path).json()
      : JSON.parse(await readFile(path, "utf8"));
  },
  async writeText(path, content) {
    /* v8 ignore next 2 */
    if (typeof Bun !== "undefined") await Bun.write(path, content);
    else await writeFile(path, content, "utf8");
  },
  createAbortController() {
    return new AbortController();
  },
  setTimer(callback, delay) {
    return setTimeout(callback, delay);
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
};

const NpmUpdateCheckProductionConfig: NpmUpdateCheckConfig = {
  updateCheckCachePath: new RigPathsClass().updateCheckCachePath,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  timeoutMs: 750,
  packageName: "@rendotdev/rig",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NpmUpdateCheckService extends defineService({
  params: NpmUpdateCheckProductionConfig,
  deps: NpmUpdateCheckProductionDeps,
}) {
  private notice(params: {
    currentVersion: string;
    latestVersion: string | undefined;
  }): UpdateCheckNotice | undefined {
    if (
      !params.latestVersion ||
      !VersionComparatorSingleton.isNewer({
        candidate: params.latestVersion,
        current: params.currentVersion,
      })
    ) {
      return undefined;
    }
    return {
      packageName: this.params.packageName,
      currentVersion: params.currentVersion,
      latestVersion: params.latestVersion,
      message: `Rig update available: ${this.params.packageName} ${params.currentVersion} -> ${params.latestVersion}. Run npm install -g ${this.params.packageName}.`,
    };
  }

  private isFresh(params: { cache: UpdateCheckCache }): boolean {
    return this.deps.now() - params.cache.checkedAt < this.params.cacheTtlMs;
  }

  private registryUrl(_params: {}): string {
    return `https://registry.npmjs.org/${encodeURIComponent(this.params.packageName)}/latest`;
  }

  private async fetchLatestVersion(_params: {}): Promise<string | undefined> {
    const controller = this.deps.createAbortController();
    const timer = this.deps.setTimer(function abortRequest() {
      controller.abort();
    }, this.params.timeoutMs);

    try {
      const response = await this.deps.fetch(this.registryUrl({}), {
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const data = await response.json();
      if (!isRecord(data) || typeof data.version !== "string") return undefined;
      return data.version;
    } catch {
      return undefined;
    } finally {
      this.deps.clearTimer(timer);
    }
  }

  private async readCache(_params: {}): Promise<UpdateCheckCache | undefined> {
    try {
      const data = await this.deps.readJson(this.params.updateCheckCachePath);
      if (!isRecord(data) || typeof data.checkedAt !== "number") return undefined;
      return {
        checkedAt: data.checkedAt,
        latestVersion: typeof data.latestVersion === "string" ? data.latestVersion : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private async writeCache(params: { cache: UpdateCheckCache }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(this.params.updateCheckCachePath), {
      recursive: true,
    });
    await this.deps.writeText(
      this.params.updateCheckCachePath,
      `${JSON.stringify(params.cache, null, 2)}\n`,
    );
  }

  public async check(params: { currentVersion: string }): Promise<UpdateCheckNotice | undefined> {
    if (this.deps.env.RIG_UPDATE_CHECK === "0") return undefined;

    const cached = await this.readCache({});
    if (cached && this.isFresh({ cache: cached })) {
      return this.notice({
        currentVersion: params.currentVersion,
        latestVersion: cached.latestVersion,
      });
    }

    const latestVersion = await this.fetchLatestVersion({});
    if (!latestVersion) return undefined;

    await this.writeCache({ cache: { checkedAt: this.deps.now(), latestVersion } });
    return this.notice({ currentVersion: params.currentVersion, latestVersion });
  }
}

export const NpmUpdateCheck = new NpmUpdateCheckService();

export type NpmUpdateCheckServiceClass = {
  check(currentVersion: string): Promise<UpdateCheckNotice | undefined>;
};

type NpmUpdateCheckServiceConstructor = {
  new (options?: UpdateCheckOptions): NpmUpdateCheckServiceClass;
  readonly prototype: NpmUpdateCheckServiceClass;
};

type NpmUpdateCheckServiceAdapter = NpmUpdateCheckServiceClass & {
  readonly resource: NpmUpdateCheckService;
};

const NpmUpdateCheckServiceClassAdapter = function constructNpmUpdateCheckService(
  this: NpmUpdateCheckServiceAdapter,
  options: UpdateCheckOptions = {},
): void {
  const paths = new RigPathsClass(options);
  Object.defineProperty(this, "resource", {
    value: new NpmUpdateCheckService({
      params: {
        updateCheckCachePath: paths.updateCheckCachePath,
        cacheTtlMs: options.cacheTtlMs ?? NpmUpdateCheckProductionConfig.cacheTtlMs,
        timeoutMs: options.timeoutMs ?? NpmUpdateCheckProductionConfig.timeoutMs,
        packageName: options.packageName ?? NpmUpdateCheckProductionConfig.packageName,
      },
      deps: {
        ...NpmUpdateCheckProductionDeps,
        env: process.env,
        now: options.now ?? NpmUpdateCheckProductionDeps.now,
        fetch: options.fetch ?? NpmUpdateCheckProductionDeps.fetch,
      },
    }),
  });
};
Object.defineProperty(NpmUpdateCheckServiceClassAdapter, "name", {
  value: "NpmUpdateCheckServiceClass",
});
Object.defineProperty(NpmUpdateCheckServiceClassAdapter.prototype, "check", {
  configurable: true,
  value: function check(this: NpmUpdateCheckServiceAdapter, currentVersion: string) {
    return this.resource.check({ currentVersion });
  },
  writable: true,
});

export const NpmUpdateCheckServiceClass =
  NpmUpdateCheckServiceClassAdapter as unknown as NpmUpdateCheckServiceConstructor;
