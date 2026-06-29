import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class RigPackageRoot {
  static find(metaUrl: string): string {
    if (process.env.RIG_PACKAGE_ROOT) return resolve(process.env.RIG_PACKAGE_ROOT);

    const argvRoot = this.fromEntrypoint(process.argv[1]);
    if (argvRoot) return argvRoot;

    const execRoot = this.fromEntrypoint(process.execPath);
    if (execRoot) return execRoot;

    if (this.isBunBinary(metaUrl)) return dirname(process.execPath);

    return join(dirname(fileURLToPath(metaUrl)), "..", "..");
  }

  static packageFile(metaUrl: string, ...parts: string[]): string {
    return join(this.find(metaUrl), ...parts);
  }

  private static isBunBinary(metaUrl: string): boolean {
    return metaUrl.includes("$bunfs") || metaUrl.includes("~BUN") || metaUrl.includes("%7EBUN");
  }

  private static fromEntrypoint(entrypoint: string | undefined): string | undefined {
    if (!entrypoint) return undefined;
    const resolved = this.safeRealpath(entrypoint);
    if (!resolved) return undefined;

    const parent = dirname(resolved);
    const parentName = basename(parent);
    if (parentName === "src" || parentName === "dist") return dirname(parent);
    return undefined;
  }

  private static safeRealpath(pathValue: string): string | undefined {
    try {
      return realpathSync(pathValue);
    } catch {
      const absolute = resolve(pathValue);
      return existsSync(absolute) ? absolute : undefined;
    }
  }
}
