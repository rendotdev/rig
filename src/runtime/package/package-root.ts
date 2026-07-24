import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineService } from "../../define";

type RigPackageRootServiceDeps = {
  getRigPackageRootEnvironment: () => string | undefined;
  getArgvEntrypoint: () => string | undefined;
  getExecPath: () => string;
  existsSync: (pathValue: string) => boolean;
  realpathSync: (pathValue: string) => string;
  basename: (pathValue: string) => string;
  dirname: (pathValue: string) => string;
  join: (...parts: string[]) => string;
  resolve: (pathValue: string) => string;
  fileURLToPath: (metaUrl: string) => string;
};

const RigPackageRootServiceDeps: RigPackageRootServiceDeps = {
  getRigPackageRootEnvironment: function getRigPackageRootEnvironment() {
    return process.env.RIG_PACKAGE_ROOT;
  },
  getArgvEntrypoint: function getArgvEntrypoint() {
    return process.argv[1];
  },
  getExecPath: function getExecPath() {
    return process.execPath;
  },
  existsSync,
  realpathSync,
  basename,
  dirname,
  join,
  resolve,
  fileURLToPath,
};

function isBunBinary(params: { metaUrl: string }): boolean {
  return (
    params.metaUrl.includes("$bunfs") ||
    params.metaUrl.includes("~BUN") ||
    params.metaUrl.includes("%7EBUN")
  );
}

export class RigPackageRootService extends defineService({
  params: {},
  deps: RigPackageRootServiceDeps,
}) {
  private safeRealpath(params: { pathValue: string }): string | undefined {
    try {
      return this.deps.realpathSync(params.pathValue);
    } catch {
      const absolute = this.deps.resolve(params.pathValue);
      /* v8 ignore next */
      return this.deps.existsSync(absolute) ? absolute : undefined;
    }
  }

  public fromEntrypoint(params: { entrypoint: string | undefined }): string | undefined {
    if (!params.entrypoint) return undefined;
    const resolved = this.safeRealpath({ pathValue: params.entrypoint });
    if (!resolved) return undefined;

    const parent = this.deps.dirname(resolved);
    const parentName = this.deps.basename(parent);
    if (parentName === "src" || parentName === "dist") return this.deps.dirname(parent);
    return undefined;
  }

  public fromModule(params: { metaUrl: string }): string | undefined {
    let current = this.deps.dirname(this.deps.fileURLToPath(params.metaUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      if (this.deps.existsSync(this.deps.join(current, "package.json"))) return current;
      const parent = this.deps.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return undefined;
  }

  public find(params: { metaUrl: string }): string {
    const environmentRoot = this.deps.getRigPackageRootEnvironment();
    if (environmentRoot) return this.deps.resolve(environmentRoot);

    const argvRoot = this.fromEntrypoint({ entrypoint: this.deps.getArgvEntrypoint() });
    if (argvRoot) return argvRoot;

    const execRoot = this.fromEntrypoint({ entrypoint: this.deps.getExecPath() });
    if (execRoot) return execRoot;

    if (isBunBinary(params)) return this.deps.dirname(this.deps.getExecPath());

    const moduleRoot = this.fromModule(params);
    if (moduleRoot) return moduleRoot;

    return this.deps.join(this.deps.dirname(this.deps.fileURLToPath(params.metaUrl)), "..", "..");
  }

  public packageFile(params: { metaUrl: string; parts: readonly string[] }): string {
    return this.deps.join(this.find({ metaUrl: params.metaUrl }), ...params.parts);
  }
}

export const RigPackageRoot = new RigPackageRootService();

type RigPackageRootCompatibility = {
  find(metaUrl: string): string;
  packageFile(metaUrl: string, ...parts: string[]): string;
  fromEntrypoint(entrypoint: string | undefined): string | undefined;
  fromModule(metaUrl: string): string | undefined;
};

type RigPackageRootConstructor = {
  new (): RigPackageRootCompatibility;
  new (params: object, deps: object): RigPackageRootCompatibility;
  readonly prototype: RigPackageRootCompatibility;
};

function createRigPackageRootCompatibility(
  service: RigPackageRootService,
): RigPackageRootCompatibility {
  return Object.assign(Object.create(RigPackageRootClassAdapter.prototype), {
    find(metaUrl: string) {
      return service.find({ metaUrl });
    },
    packageFile(metaUrl: string, ...parts: string[]) {
      return service.packageFile({ metaUrl, parts });
    },
    fromEntrypoint(entrypoint: string | undefined) {
      return service.fromEntrypoint({ entrypoint });
    },
    fromModule(metaUrl: string) {
      return service.fromModule({ metaUrl });
    },
  }) as RigPackageRootCompatibility;
}

function RigPackageRootClassAdapter() {
  return createRigPackageRootCompatibility(RigPackageRoot);
}

export const RigPackageRootClass =
  RigPackageRootClassAdapter as unknown as RigPackageRootConstructor;
export const rigPackageRoot = new RigPackageRootClass();
