import type { TextProps } from "ink";
import { defineSingleton } from "../../define";

type TerminalColorsValue = {
  readonly loading: NonNullable<TextProps["color"]>;
  readonly success: NonNullable<TextProps["color"]>;
  readonly error: NonNullable<TextProps["color"]>;
  readonly muted: NonNullable<TextProps["color"]>;
};

type TerminalIconsValue = {
  readonly success: string;
  readonly error: string;
  loading(params: { frame: number }): string;
};

type LegacyConstructor<Value> = {
  new (params: {}, deps: {}): Value;
  readonly prototype: Value;
};

function TerminalColorsClassAdapter(this: TerminalColorsValue) {
  Object.assign(this, TerminalColorsSingleton);
}

function TerminalIconsClassAdapter(this: TerminalIconsValue) {
  Object.assign(this, TerminalIconsSingleton);
}

export const TerminalColorsSingleton = defineSingleton({
  params: {},
  deps: {},
  loading: "cyan" as NonNullable<TextProps["color"]>,
  success: "green" as NonNullable<TextProps["color"]>,
  error: "red" as NonNullable<TextProps["color"]>,
  muted: "gray" as NonNullable<TextProps["color"]>,
});

export const TerminalIconsSingleton = defineSingleton({
  params: {
    loadingFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  },
  deps: {},
  success: "✔",
  error: "✖",
  loading(params: { frame: number }): string {
    return this.params.loadingFrames[params.frame % this.params.loadingFrames.length] as string;
  },
});

export const TerminalColorsClass =
  TerminalColorsClassAdapter as unknown as LegacyConstructor<TerminalColorsValue>;
export const TerminalIconsClass =
  TerminalIconsClassAdapter as unknown as LegacyConstructor<TerminalIconsValue>;
export const TerminalColors = TerminalColorsSingleton;
export const TerminalIcons = TerminalIconsSingleton;
