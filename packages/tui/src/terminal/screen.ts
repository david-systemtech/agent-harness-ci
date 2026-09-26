import xterm from "@xterm/headless";
import { TERMINAL_SCROLLBACK } from "@agent-harness/contracts";
import { colourOf, sameStyle, type Span } from "../transcript/lines.js";

/**
 * The terminal pane's screen model (docs/specs/tui.md, "The terminal pane"):
 * a headless terminal emulator, `@xterm/headless`, that a terminal's output
 * is written into as it arrives, and whose cells are read back as rows of
 * styled spans for Ink's `Text` to draw. The emulator does what a terminal
 * does with the bytes (cursor movement, carriage returns, the alternate
 * screen, colours); the pane only draws what it holds. Its scrollback is
 * the environment's line cap, so the pager (`terminal.scrollback`) reads
 * what the environment would replay.
 *
 * `@xterm/headless` 6.0.0 is a CommonJS bundle with no dependencies whose
 * `module` field names a file it does not ship: Node's ESM loader finds no
 * named export in it, so it is imported whole and `Terminal` read off it;
 * and it counts its buffer reads as proposed API, so it is made with
 * `allowProposedApi`.
 * Its `write` parses on a timer of its own, so every write here is a
 * promise that settles once the emulator has taken it in.
 */

/** The modes an application in the terminal set that change what a key or a paste sends. */
export interface ScreenModes {
  /** DECCKM: the arrow keys are sent in their application form (`ESC O A`). */
  readonly applicationCursorKeys: boolean;
  /** The application asked for pastes wrapped in `ESC [200~` and `ESC [201~`. */
  readonly bracketedPaste: boolean;
}

export interface Screen {
  cols(): number;
  rows(): number;
  /** Takes `data` in; settles once the emulator has. */
  write(data: string): Promise<void>;
  /** Starts again from nothing (a full reset: the screen, the scrollback, the modes), then takes `data` in. */
  reset(data?: string): Promise<void>;
  resize(cols: number, rows: number): void;
  /** The rows on screen now, as styled lines; the cursor's cell inverse when `cursor` is asked and the application shows it. */
  view(options?: { readonly cursor?: boolean }): readonly (readonly Span[])[];
  /** Every line the main buffer holds, the oldest first, trailing blank lines dropped: the retained scrollback. */
  history(): readonly (readonly Span[])[];
  /** The main buffer as text, lines the width wrapped joined again, each line's trailing blanks and the trailing blank lines dropped. */
  text(): string;
  modes(): ScreenModes;
  /** What the emulator answers a query with (a cursor position report, device attributes), as keys to send back. */
  onAnswer(listener: (data: string) => void): () => void;
  dispose(): void;
}

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<xterm.Terminal["buffer"]["active"]["getLine"]>>["getCell"]>>;
type Style = Omit<Span, "text">;

const styleOf = (cell: Cell): Style => {
  const color = colourOf({ palette: cell.isFgPalette(), rgb: cell.isFgRGB(), value: cell.getFgColor() });
  const background = colourOf({ palette: cell.isBgPalette(), rgb: cell.isBgRGB(), value: cell.getBgColor() });
  if (cell.isInvisible() !== 0) return background === undefined ? {} : { background };
  return {
    ...(color !== undefined && { color }),
    ...(background !== undefined && { background }),
    ...(cell.isBold() !== 0 && { bold: true }),
    ...(cell.isDim() !== 0 && { dim: true }),
    ...(cell.isItalic() !== 0 && { italic: true }),
    ...(cell.isUnderline() !== 0 && { underline: true }),
    ...(cell.isInverse() !== 0 && { inverse: true }),
    ...(cell.isStrikethrough() !== 0 && { strikethrough: true }),
  };
};

const isPlain = (style: Style): boolean => Object.keys(style).length === 0;

/** One row's cells as spans: a wide character's second cell skipped, trailing plain blanks dropped (the cursor's cell kept). */
const spansOf = (term: xterm.Terminal, y: number, buffer: xterm.Terminal["buffer"]["active"], cursorX?: number): Span[] => {
  const line = buffer.getLine(y);
  if (!line) return [];
  const cells: { readonly text: string; readonly style: Style }[] = [];
  let cursorAt = -1;
  const scratch = buffer.getNullCell();
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue;
    let style = styleOf(cell);
    const text = cell.isInvisible() !== 0 ? " ".repeat(Math.max(1, cell.getWidth())) : cell.getChars() || " ";
    if (x === cursorX) {
      cursorAt = cells.length;
      // The cursor is drawn by swapping the cell's colours, as a terminal draws a block cursor.
      const { inverse, ...rest } = style;
      style = inverse === true ? rest : { ...rest, inverse: true };
    }
    cells.push({ text, style });
  }
  let keep = cells.length;
  while (keep > 0 && keep - 1 !== cursorAt) {
    const last = cells[keep - 1];
    if (!last || last.text.trim().length > 0 || !isPlain(last.style)) break;
    keep--;
  }
  const spans: Span[] = [];
  for (const { text, style } of cells.slice(0, keep)) {
    const last = spans.at(-1);
    if (last && sameStyle(last, style)) spans[spans.length - 1] = { ...last, text: last.text + text };
    else spans.push({ ...style, text });
  }
  return spans;
};

export const createScreen = (options: { readonly cols: number; readonly rows: number; readonly scrollback?: number }): Screen => {
  // The headless build marks its buffer reads proposed: `allowProposedApi` is what lets the pane read its cells at all.
  const term = new xterm.Terminal({ cols: options.cols, rows: options.rows, scrollback: options.scrollback ?? TERMINAL_SCROLLBACK.lines, allowProposedApi: true });
  const write = (data: string): Promise<void> => (data.length === 0 ? Promise.resolve() : new Promise((resolve) => term.write(data, resolve)));
  // Whether the application shows the cursor (DECTCEM, `CSI ? 25 h` and `l`): no public API reads it, so the parser's
  // hooks watch for it, handing each sequence on to the emulator's own handling; a full reset shows it again.
  let cursorShown = true;
  const watchCursor = (shown: boolean) => (params: readonly (number | number[])[]) => {
    if (params.includes(25)) cursorShown = shown;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, watchCursor(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, watchCursor(false));
  term.parser.registerEscHandler({ final: "c" }, () => {
    cursorShown = true;
    return false;
  });
  return {
    cols: () => term.cols,
    rows: () => term.rows,
    write,
    reset(data = "") {
      term.reset();
      cursorShown = true;
      return write(data);
    },
    resize(cols, rows) {
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    },
    view(viewOptions = {}) {
      const buffer = term.buffer.active;
      const cursorRow = viewOptions.cursor === true && cursorShown ? buffer.cursorY : -1;
      return Array.from({ length: term.rows }, (_, row) =>
        spansOf(term, buffer.baseY + row, buffer, row === cursorRow ? Math.min(buffer.cursorX, term.cols - 1) : undefined),
      );
    },
    history() {
      const buffer = term.buffer.normal;
      const lines = Array.from({ length: buffer.length }, (_, y) => spansOf(term, y, buffer));
      while (lines.length > 0 && (lines.at(-1)?.length ?? 0) === 0) lines.pop();
      return lines;
    },
    text() {
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
    },
    modes: () => ({ applicationCursorKeys: term.modes.applicationCursorKeysMode, bracketedPaste: term.modes.bracketedPasteMode }),
    onAnswer(listener) {
      const subscription = term.onData(listener);
      return () => subscription.dispose();
    },
    dispose: () => term.dispose(),
  };
};
