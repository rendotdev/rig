import type { TextProps } from "ink";

export const TerminalColors = {
  loading: "cyan" as NonNullable<TextProps["color"]>,
  success: "green" as NonNullable<TextProps["color"]>,
  error: "red" as NonNullable<TextProps["color"]>,
  muted: "gray" as NonNullable<TextProps["color"]>,
} as const;

const terminalLoadingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const TerminalIcons = {
  success: "✔",
  error: "✖",
  loading: (params: { frame: number }): string =>
    terminalLoadingFrames[params.frame % terminalLoadingFrames.length] as string,
} as const;
