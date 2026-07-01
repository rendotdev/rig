import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RigPaths, type PathOptions } from "../config/paths";

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

class VersionComparator {
  isNewer(candidate: string, current: string): boolean {
    return this.compare(candidate, current) > 0;
  }

  private compare(left: string, right: string): number {
    const leftParts = this.parts(left);
    const rightParts = this.parts(right);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index++) {
      const leftPart = leftParts[index] ?? 0;
      const rightPart = rightParts[index] ?? 0;
      if (leftPart > rightPart) return 1;
      if (leftPart < rightPart) return -1;
    }

    return 0;
  }

  private parts(version: string): number[] {
    return version
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
  }
}

export class NpmUpdateCheckService {
  private readonly paths: RigPaths;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetcher: FetchLike;
  private readonly packageName: string;
  private readonly versions = new VersionComparator();

  constructor(options: UpdateCheckOptions = {}) {
    this.paths = new RigPaths(options);
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 750;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.packageName = options.packageName ?? "@rendotdev/rig";
  }

  async check(currentVersion: string): Promise<UpdateCheckNotice | undefined> {
    if (process.env.RIG_UPDATE_CHECK === "0") return undefined;

    const cached = await this.readCache();
    if (cached && this.isFresh(cached)) return this.notice(currentVersion, cached.latestVersion);

    const latestVersion = await this.fetchLatestVersion();
    if (!latestVersion) return undefined;

    await this.writeCache({ checkedAt: this.now(), latestVersion });
    return this.notice(currentVersion, latestVersion);
  }

  private notice(
    currentVersion: string,
    latestVersion: string | undefined,
  ): UpdateCheckNotice | undefined {
    if (!latestVersion || !this.versions.isNewer(latestVersion, currentVersion)) return undefined;
    return {
      packageName: this.packageName,
      currentVersion,
      latestVersion,
      message: `Rig update available: ${this.packageName} ${currentVersion} -> ${latestVersion}. Run npm install -g ${this.packageName}.`,
    };
  }

  private isFresh(cache: UpdateCheckCache): boolean {
    return this.now() - cache.checkedAt < this.cacheTtlMs;
  }

  private async fetchLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(this.registryUrl(), { signal: controller.signal });
      if (!response.ok) return undefined;
      const data = await response.json();
      if (!this.isRecord(data) || typeof data.version !== "string") return undefined;
      return data.version;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private registryUrl(): string {
    return `https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/latest`;
  }

  private async readCache(): Promise<UpdateCheckCache | undefined> {
    try {
      /* v8 ignore next 3 */
      const data =
        typeof Bun !== "undefined"
          ? await Bun.file(this.paths.updateCheckCachePath).json()
          : JSON.parse(await readFile(this.paths.updateCheckCachePath, "utf8"));
      if (!this.isRecord(data) || typeof data.checkedAt !== "number") return undefined;
      return {
        checkedAt: data.checkedAt,
        latestVersion: typeof data.latestVersion === "string" ? data.latestVersion : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private async writeCache(cache: UpdateCheckCache): Promise<void> {
    await mkdir(dirname(this.paths.updateCheckCachePath), { recursive: true });
    const content = `${JSON.stringify(cache, null, 2)}\n`;
    /* v8 ignore next 3 */
    if (typeof Bun !== "undefined") await Bun.write(this.paths.updateCheckCachePath, content);
    else await writeFile(this.paths.updateCheckCachePath, content, "utf8");
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
