import type { RegistryKind } from "./registry";

export const RigToolEntryFiles = ["index.rig.ts", "index.rig.tsx"] as const;

export type ToolDiscoveryOptions = Readonly<{
  visibleFromPath?: string;
}>;

export type DiscoveredTool = Readonly<{
  name: string;
  registryKind: RegistryKind;
  registryPath: string;
  toolDir: string;
  toolPath: string;
}>;
