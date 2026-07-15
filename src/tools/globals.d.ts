import type { RigToolKit as RigToolKitType, ToolFactory } from "./types";

declare global {
  type RigToolFactory = ToolFactory;
  type RigToolKit = RigToolKitType;
}
