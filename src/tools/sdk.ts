import { z } from "zod";
import type { ToolDefinition } from "./types";

export { z };

export class RigTool {
  static define<T extends ToolDefinition>(definition: T): T {
    return definition;
  }
}
