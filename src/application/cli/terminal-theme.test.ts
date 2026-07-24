import { describe, expect, it } from "vite-plus/test";
import {
  TerminalColorsClass,
  TerminalColorsSingleton,
  TerminalIconsClass,
  TerminalIconsSingleton,
  TerminalColors,
  TerminalIcons,
} from "./terminal-theme";

describe("terminal theme", () => {
  it("builds semantic color values and preserves legacy construction", () => {
    const BuiltColors = TerminalColorsSingleton;
    const Colors = new TerminalColorsClass({}, {});

    expect(BuiltColors).toMatchObject({
      loading: "cyan",
      success: "green",
      error: "red",
      muted: "gray",
    });
    expect(Colors).toMatchObject(BuiltColors);
    expect(Colors).toBeInstanceOf(TerminalColorsClass);
    expect(TerminalColors).toBe(TerminalColorsSingleton);
  });

  it("builds status icons and cycles loading frames", () => {
    const BuiltIcons = TerminalIconsSingleton;
    const Icons = new TerminalIconsClass({}, {});

    expect(Icons.success).toBe("✔");
    expect(Icons.error).toBe("✖");
    expect(Icons.loading({ frame: 0 })).toBe("⠋");
    expect(Icons.loading({ frame: 10 })).toBe("⠋");
    expect(BuiltIcons.loading({ frame: 9 })).toBe("⠏");
    expect(TerminalIconsSingleton.loading({ frame: 1 })).toBe("⠙");
    expect(Icons).toBeInstanceOf(TerminalIconsClass);
    expect(TerminalIcons).toBe(TerminalIconsSingleton);
  });
});
