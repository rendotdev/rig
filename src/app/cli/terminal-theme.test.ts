import { describe, expect, it } from "vite-plus/test";
import { TerminalColors, TerminalIcons } from "./terminal-theme";

describe("terminal theme", () => {
  it("provides semantic color values", () => {
    expect(TerminalColors).toMatchObject({
      loading: "cyan",
      success: "green",
      error: "red",
      muted: "gray",
    });
  });

  it("provides status icons and cycles loading frames", () => {
    expect(TerminalIcons.success).toBe("✔");
    expect(TerminalIcons.error).toBe("✖");
    expect(TerminalIcons.loading({ frame: 0 })).toBe("⠋");
    expect(TerminalIcons.loading({ frame: 9 })).toBe("⠏");
    expect(TerminalIcons.loading({ frame: 10 })).toBe("⠋");
  });
});
