import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class RigPackageRootClass {
  find(metaUrl: string): string {
    if (process.env.RIG_PACKAGE_ROOT) return resolve(process.env.RIG_PACKAGE_ROOT);

    const argvRoot = this.fromEntrypoint(process.argv[1]);
    if (argvRoot) return argvRoot;

    const execRoot = this.fromEntrypoint(process.execPath);
    if (execRoot) return execRoot;

    if (this.isBunBinary(metaUrl)) return dirname(process.execPath);

    const moduleRoot = this.fromModule(metaUrl);
    if (moduleRoot) return moduleRoot;

    return join(dirname(fileURLToPath(metaUrl)), "..", "..");
  }

  packageFile(metaUrl: string, ...parts: string[]): string {
    return join(this.find(metaUrl), ...parts);
  }

  private isBunBinary(metaUrl: string): boolean {
    return metaUrl.includes("$bunfs") || metaUrl.includes("~BUN") || metaUrl.includes("%7EBUN");
  }

  private fromEntrypoint(entrypoint: string | undefined): string | undefined {
    if (!entrypoint) return undefined;
    const resolved = this.safeRealpath(entrypoint);
    if (!resolved) return undefined;

    const parent = dirname(resolved);
    const parentName = basename(parent);
    if (parentName === "src" || parentName === "dist") return dirname(parent);
    return undefined;
  }

  private fromModule(metaUrl: string): string | undefined {
    let current = dirname(fileURLToPath(metaUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(current, "package.json"))) return current;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return undefined;
  }

  private safeRealpath(pathValue: string): string | undefined {
    try {
      return realpathSync(pathValue);
    } catch {
      const absolute = resolve(pathValue);
      /* v8 ignore next */
      return existsSync(absolute) ? absolute : undefined;
    }
  }
}

export const rigPackageRoot = new RigPackageRootClass();
