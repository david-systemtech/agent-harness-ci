import { colourOf } from "../terminal/screen.js";
import { sameStyle, type Line, type Span } from "../transcript/lines.js";

/**
 * What the pager shows for a file, a diff, or a diff tool's answer
 * (docs/specs/tui.md, "The composer": `/files` reads a file in the pager;
 * "The transcript": `d` and `/diff`): lines of styled spans cut to the
 * pager's width, every character kept (a line of code is not reflowed at
 * its spaces). Pure.
 *
 * - **A file** is plain text: tabs expanded to the next stop of eight,
 *   control bytes dropped, so nothing in it can move the cursor or recolour
 *   the screen.
 * - **A diff with no tool of the user's** is coloured as `git diff` colours
 *   one: headers bold, hunk lines cyan, additions green, removals red.
 * - **A diff tool's answer** keeps the colours and attributes it wrote
 *   (SGR); every other escape it wrote (a hyperlink, an erase) is dropped.
 */

const TAB = 8;

/** Spans cut into lines of at most `width` characters; an empty logical line is one empty line. */
const cut = (spans: readonly Span[], width: number): Span[][] => {
  const room = Math.max(1, width);
  const out: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  for (const span of spans) {
    let text = "";
    for (const char of span.text) {
      if (used === room) {
        if (text.length > 0) line.push({ ...span, text });
        out.push(line);
        line = [];
        used = 0;
        text = "";
      }
      text += char;
      used++;
    }
    if (text.length > 0) {
      const last = line.at(-1);
      if (last && sameStyle(last, span)) line[line.length - 1] = { ...last, text: last.text + text };
      else line.push({ ...span, text });
    }
  }
  out.push(line);
  return out;
};

/** `text`'s tabs expanded to the next stop, measured from the line's start, `from` columns before `text`. */
const expandTabs = (text: string, from = 0): string => {
  let out = "";
  let column = from;
  for (const char of text) {
    if (char === "\t") {
      const pad = TAB - (column % TAB);
      out += " ".repeat(pad);
      column += pad;
    } else {
      out += char;
      column++;
    }
  }
  return out;
};

// eslint-disable-next-line no-control-regex -- the control bytes are what is being removed.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- the same, the tab left for `expandTabs`.
const CONTROLS_BUT_TAB = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

const pageLines = (logical: readonly (readonly Span[])[], width: number, name: string): Line[] =>
  logical.flatMap((spans, index) => cut(spans, width).map((line): Line => ({ row: `${name}:${index}`, spans: line })));

/** A file's text as the pager draws it. */
export const plainPage = (text: string, width: number): Line[] =>
  pageLines(
    text.split("\n").map((line) => {
      const clean = expandTabs(line.replace(/\r$/, "")).replace(CONTROLS, "");
      return clean.length === 0 ? [] : [{ text: clean }];
    }),
    width,
    "file",
  );

/** How a diff line is drawn when no tool of the user's colours it: as `git diff` would. */
const diffStyle = (line: string): Omit<Span, "text"> => {
  if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) return { bold: true };
  if (line.startsWith("@@")) return { color: "cyan" };
  if (line.startsWith("+")) return { color: "green" };
  if (line.startsWith("-")) return { color: "red" };
  return {};
};

/** A unified diff, coloured as a diff. */
export const diffPage = (text: string, width: number): Line[] =>
  pageLines(
    text.split("\n").map((line) => {
      const clean = expandTabs(line.replace(/\r$/, "")).replace(CONTROLS, "");
      return clean.length === 0 ? [] : [{ ...diffStyle(clean), text: clean }];
    }),
    width,
    "diff",
  );

type Style = { -readonly [K in keyof Omit<Span, "text">]: Span[K] };

/** A palette entry's colour, as a cell's is drawn. */
const palette = (value: number): string => `ansi256(${String(value)})`;

/** The style after one SGR sequence's parameters, from `style`. */
const applySgr = (style: Style, params: readonly number[]): Style => {
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    const colour = (): string | undefined => {
      // 38;5;n or 38;2;r;g;b (and the same for 48).
      const mode = params[i + 1];
      if (mode === 5) {
        const value = params[i + 2] ?? 0;
        i += 2;
        return colourOf({ palette: true, rgb: false, value });
      }
      if (mode === 2) {
        const [r = 0, g = 0, b = 0] = params.slice(i + 2, i + 5);
        i += 4;
        return colourOf({ palette: false, rgb: true, value: (r << 16) | (g << 8) | b });
      }
      return undefined;
    };
    if (p === 0) for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strikethrough = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p === 29) delete next.strikethrough;
    else if (p >= 30 && p <= 37) next.color = palette(p - 30);
    else if (p >= 90 && p <= 97) next.color = palette(p - 90 + 8);
    else if (p >= 40 && p <= 47) next.background = palette(p - 40);
    else if (p >= 100 && p <= 107) next.background = palette(p - 100 + 8);
    else if (p === 38) {
      const value = colour();
      if (value === undefined) delete next.color;
      else next.color = value;
    } else if (p === 48) {
      const value = colour();
      if (value === undefined) delete next.background;
      else next.background = value;
    } else if (p === 39) delete next.color;
    else if (p === 49) delete next.background;
  }
  return next;
};

/** An escape sequence: CSI (its final byte kept, to tell SGR), OSC (to BEL or ST), or any other two-byte one. */
// eslint-disable-next-line no-control-regex -- escape sequences are what is being read.
const ESCAPE = /\u001B(?:\[([0-9;:?]*)([@-~])|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Text a tool coloured with escape sequences, as the pager draws it. */
export const sgrPage = (text: string, width: number): Line[] => {
  let style: Style = {};
  const logical = text.split("\n").map((raw) => {
    const spans: Span[] = [];
    let column = 0;
    const add = (piece: string) => {
      const clean = expandTabs(piece.replace(/\r$/, "").replace(CONTROLS_BUT_TAB, ""), column);
      column += [...clean].length;
      if (clean.length === 0) return;
      const last = spans.at(-1);
      if (last && sameStyle(last, style)) spans[spans.length - 1] = { ...last, text: last.text + clean };
      else spans.push({ ...style, text: clean });
    };
    let at = 0;
    for (const match of raw.matchAll(ESCAPE)) {
      add(raw.slice(at, match.index));
      at = match.index + match[0].length;
      if (match[2] === "m") style = applySgr(style, (match[1] ?? "").split(/[;:]/).map((p) => (p === "" ? 0 : Number(p))));
    }
    add(raw.slice(at));
    return spans;
  });
  return pageLines(logical, width, "tool");
};
