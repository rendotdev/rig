export type RegistryKind = "base" | "custom";

export type RegistryEntry = Readonly<{
  kind: RegistryKind;
  path: string;
}>;

export type RegistryConfigInput = Readonly<{
  baseRegistryDir: string;
  customRegistries: string[];
}>;

export type RegistryConfigState = Readonly<{
  baseRegistryDir: string;
  customRegistries: string[];
  registries: RegistryEntry[];
}>;
