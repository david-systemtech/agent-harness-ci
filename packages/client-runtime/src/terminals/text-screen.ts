/**
 * A terminal's output read as a person saw it (docs/specs/tui.md, "The
 * terminal pane"; docs/specs/gui.md, "A session pane"): written into a
 * terminal emulator, then read back as text. The runtime holds no emulator
 * of its own (it depends on contracts alone): each renderer hands it the one
 * it draws with, the terminal UI its headless xterm.js and the window its
 * xterm.js, so `!!`'s output is read the way the pane would show it. Both
 * builds of xterm.js answer the same buffer reads, which `xtermText` and
 * `xtermFull` make of them.
 */

/** A terminal emulator a renderer hands the runtime to read output through. */
export interface TextScreen {
  /** Takes `data` in; settles once the emulator has. */
  write(data: string): Promise<void>;
  /** The main buffer as text, lines the width wrapped joined again, each line's trailing blanks and the trailing blank lines dropped. */
  text(): string;
  /** Whether the main buffer holds as many lines as it can, the rows and the scrollback: a line more drops its oldest. */
  full(): boolean;
  dispose(): void;
}

/** Makes a screen `cols` wide and `rows` high keeping `scrollback` lines above them. */
export type TextScreens = (size: { readonly cols: number; readonly rows: number; readonly scrollback: number }) => TextScreen;

/** A line of an xterm.js buffer, as both builds (`@xterm/xterm`, `@xterm/headless`) read it. */
interface XtermLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** What of an xterm.js terminal, either build, a text screen reads. */
export interface Xterm {
  readonly rows: number;
  readonly options: { readonly scrollback?: number | undefined };
  readonly buffer: { readonly normal: { readonly length: number; getLine(y: number): XtermLine | undefined } };
  write(data: string, callback?: () => void): void;
  dispose(): void;
}

/** The main buffer as text, lines the width wrapped joined again, each line's trailing blanks and the trailing blank lines dropped. */
export const xtermText = (term: Xterm): string => {
  const buffer = term.buffer.normal;
  const out: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // A line the width wrapped goes on with the next, whose own blanks are part of it.
    const wrapsOn = buffer.getLine(y + 1)?.isWrapped === true;
    const piece = line.translateToString(!wrapsOn);
    if (line.isWrapped && out.length > 0) out[out.length - 1] += piece;
    else out.push(piece);
  }
  const trimmed = out.map((line) => line.trimEnd());
  while (trimmed.length > 0 && trimmed.at(-1) === "") trimmed.pop();
  return trimmed.join("\n");
};

/** Whether the main buffer holds as many lines as it can, the rows and the scrollback. */
export const xtermFull = (term: Xterm): boolean => term.buffer.normal.length >= term.rows + (term.options.scrollback ?? 0);

/** `term` as a text screen. */
export const xtermScreen = (term: Xterm): TextScreen => ({
  write: (data) => (data.length === 0 ? Promise.resolve() : new Promise((resolve) => term.write(data, resolve))),
  text: () => xtermText(term),
  full: () => xtermFull(term),
  dispose: () => term.dispose(),
});
