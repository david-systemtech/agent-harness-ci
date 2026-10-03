import { readCssColour, toHex, type LadderName, type TokenName } from "@agent-harness/theme";
import type { ITheme } from "@xterm/xterm";
import { useEffect, useState } from "react";
import { XTERM_FALLBACK_THEME } from "./xterm-fallback-theme.js";

/** look.md §8.3: xterm reads token colours as hex, including alpha for its transparent ground and selection. */
export const terminalTheme = (token: (name: TokenName) => string, ladder: LadderName = "dark"): ITheme => {
  const tokens: Readonly<Partial<Record<keyof ITheme, TokenName>>> = {
    background: "panel", foreground: "ink", cursor: "beam", cursorAccent: "panel", selectionBackground: "beam",
    black: ladder === "dark" ? "abyss" : "ink",
    white: ladder === "dark" ? "ink" : "abyss",
    brightWhite: ladder === "dark" ? "ink" : "abyss",
    red: "signal", brightRed: "signal", green: "mint", brightGreen: "sage",
    yellow: "amber", brightYellow: "amber", blue: "cyan", brightBlue: "cyan",
    cyan: "cyan", brightCyan: "cyan", magenta: "beam-text", brightMagenta: "beam-text", brightBlack: "ink-faint",
  };
  const theme: Record<string, string> = { ...XTERM_FALLBACK_THEME };
  for (const [key, name] of Object.entries(tokens)) {
    const colour = readCssColour(token(name));
    if (colour !== undefined) theme[key] = toHex(colour);
  }
  // xterm's alpha parser needs a concrete colour, even for a transparent surface.
  theme["background"] += "00";
  theme["selectionBackground"] += "47"; // 28% beam.
  return theme;
};

/** The theme the document's root is painted in now, as xterm.js takes it. */
const paintedTheme = (): ITheme => {
  const painted = getComputedStyle(document.documentElement);
  return terminalTheme((name) => painted.getPropertyValue(`--${name}`), document.documentElement.dataset["ladder"] === "light" ? "light" : "dark");
};

const same = (a: ITheme, b: ITheme): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The terminal's theme from the tokens the window painted, followed as the root is painted again. */
export const useTerminalTheme = (): ITheme => {
  const [theme, setTheme] = useState(paintedTheme);
  useEffect(() => {
    const read = () => {
      const next = paintedTheme();
      setTheme((held) => (same(held, next) ? held : next));
    };
    // Painted since the first read (the window paints its root after its children first draw).
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-ladder"] });
    return () => observer.disconnect();
  }, []);
  return theme;
};
