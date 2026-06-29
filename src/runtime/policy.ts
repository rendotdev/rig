import { RigError } from "../errors/RigError";
import type { SideEffectLevel } from "../tools/types";

export type PolicyOptions = {
  allowWrite?: boolean;
  allowNetwork?: boolean;
  allowShell?: boolean;
  allowDestructive?: boolean;
};

export class PolicyChecker {
  check(params: {
    tool: string;
    command: string;
    sideEffects: SideEffectLevel;
    options: PolicyOptions;
    inputSource: string;
  }): void {
    const { sideEffects, options } = params;
    if (sideEffects === "read") return;
    if (this.isAllowed(sideEffects, options)) return;

    const flag = this.flagFor(sideEffects);
    throw new RigError(
      "POLICY_CONFIRMATION_REQUIRED",
      `This command declares ${sideEffects} side effects and requires confirmation.`,
      {
        sideEffects,
        suggestedCommand: `rig run ${params.tool} ${params.command} ${params.inputSource} ${flag}`,
      },
    );
  }

  private isAllowed(sideEffects: SideEffectLevel, options: PolicyOptions): boolean {
    return (
      (sideEffects === "write" && Boolean(options.allowWrite)) ||
      (sideEffects === "network" && Boolean(options.allowNetwork)) ||
      (sideEffects === "shell" && Boolean(options.allowShell)) ||
      (sideEffects === "destructive" && Boolean(options.allowDestructive))
    );
  }

  private flagFor(sideEffects: Exclude<SideEffectLevel, "read">): string {
    return {
      write: "--allow-write",
      network: "--allow-network",
      shell: "--allow-shell",
      destructive: "--allow-destructive",
    }[sideEffects];
  }
}
