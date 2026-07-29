import type { RigToolKit as RigToolKitType, ToolFactory } from "./tool-types";

declare global {
  type RigToolFactory = ToolFactory;
  type RigToolKit = RigToolKitType;
}
