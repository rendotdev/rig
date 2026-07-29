export type DevLinkCommandOptions = { readonly binDir?: string; readonly force?: boolean };

export type DevLinkConfig = Readonly<{
  homeDir: string;
  repoRoot: string;
  platform: NodeJS.Platform;
  pathEnvironment: string;
  pathDelimiter: string;
}>;

export type DevLinkStatus = Readonly<{
  repoRoot: string;
  binDir: string;
  shimPath: string;
  exists: boolean;
  isRigDevShim: boolean;
  pointsToCurrentRepo: boolean;
  binDirOnPath: boolean;
}>;

export type ExistingDevLinkShim = Readonly<{
  exists: boolean;
  isRigDevShim: boolean;
  content: string;
}>;
