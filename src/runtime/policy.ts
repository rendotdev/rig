import { RigError } from "../errors/RigError";
import { SideEffectSet, type SideEffectDeclaration, type SideEffectLevel } from "../tools/types";

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
    sideEffects: SideEffectDeclaration;
    options: PolicyOptions;
    inputSource: string;
  }): void {
    const required = SideEffectSet.normalize(params.sideEffects).filter(
      (level) => level !== "read",
    );
    const missing = required.filter((level) => !this.isAllowed(level, params.options));
    if (missing.length === 0) return;

    const flags = missing.map((level) => this.flagFor(level));
    throw new RigError(
      "POLICY_CONFIRMATION_REQUIRED",
      `This command declares ${SideEffectSet.label(params.sideEffects)} side effects and requires confirmation.`,
      {
        sideEffects: params.sideEffects,
        missing,
        suggestedCommand: `rig run ${params.tool} ${params.command} ${params.inputSource} ${flags.join(" ")}`,
      },
    );
  }

  private isAllowed(
    sideEffects: Exclude<SideEffectLevel, "read">,
    options: PolicyOptions,
  ): boolean {
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
