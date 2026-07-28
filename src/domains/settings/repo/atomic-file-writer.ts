import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

function getProcessPid(): number {
  return process.pid;
}

export type AtomicFileWriterDeps = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (path: string, options?: { force?: boolean }) => Promise<void>;
  writeFile: (path: string, content: string, encoding: "utf8") => Promise<void>;
  dirname: (path: string) => string;
  randomUUID: () => string;
  getProcessPid: () => number;
};

export class AtomicFileWriterRepo {
  public static readonly defaultConstruction = {
    params: {},
    deps: {
      mkdir: mkdir as unknown as AtomicFileWriterDeps["mkdir"],
      rename: rename as unknown as AtomicFileWriterDeps["rename"],
      rm: rm as unknown as AtomicFileWriterDeps["rm"],
      writeFile: writeFile as unknown as AtomicFileWriterDeps["writeFile"],
      dirname,
      randomUUID: randomUUID as unknown as AtomicFileWriterDeps["randomUUID"],
      getProcessPid,
    } as AtomicFileWriterDeps,
  };
  protected readonly deps: (typeof AtomicFileWriterRepo.defaultConstruction)["deps"];

  public constructor(
    props: typeof AtomicFileWriterRepo.defaultConstruction = AtomicFileWriterRepo.defaultConstruction,
  ) {
    this.deps = props.deps;
  }

  public async write(params: { path: string; content: string }): Promise<void> {
    await this.deps.mkdir(this.deps.dirname(params.path), { recursive: true });
    const temporaryPath = `${params.path}.tmp-${this.deps.getProcessPid()}-${this.deps.randomUUID()}`;
    try {
      await this.deps.writeFile(temporaryPath, params.content, "utf8");
      await this.deps.rename(temporaryPath, params.path);
    } catch (error) {
      await this.deps.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export const AtomicFileWriter = new AtomicFileWriterRepo();

export interface AtomicFileWriterClass {
  write(path: string, content: string): Promise<void>;
}

export const AtomicFileWriterClass: new () => AtomicFileWriterClass = (function () {
  function AtomicFileWriterAdapter(): void {}

  Object.defineProperty(AtomicFileWriterAdapter.prototype, "write", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function write(path: string, content: string): Promise<void> {
      return AtomicFileWriter.write({ path, content });
    },
  });

  return AtomicFileWriterAdapter;
})() as unknown as new () => AtomicFileWriterClass;
