import { describe, expect, it } from "vite-plus/test";
import {
  TerminalColorsClass,
  TerminalIconsClass,
  TerminalColors,
  TerminalIcons,
} from "./terminal-theme";

describe("terminal theme", () => {
  it("exposes semantic colors", () => {
    const Colors = new TerminalColorsClass({}, {});

    expect(Colors).toMatchObject({
      loading: "cyan",
      success: "green",
      error: "red",
      muted: "gray",
    });
    expect(TerminalColors.success).toBe("green");
  });

  it("exposes status icons and cycles loading frames", () => {
    const Icons = new TerminalIconsClass({}, {});

    expect(Icons.success).toBe("✔");
    expect(Icons.error).toBe("✖");
    expect(Icons.loading({ frame: 0 })).toBe("⠋");
    expect(Icons.loading({ frame: 10 })).toBe("⠋");
    expect(TerminalIcons.loading({ frame: 1 })).toBe("⠙");
  });
});
