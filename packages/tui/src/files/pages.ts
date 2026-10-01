import { TERMINAL_ROLES } from "@agent-harness/theme";
import stringWidth from "string-width";
import type { DiffBand } from "../theme/colours.js";
import { colourOf, paletteColour, sameStyle, type Line, type Span } from "../transcript/lines.js";

/**
 * What the pager shows for a file, a diff, or a diff tool's answer
 * (docs/specs/tui.md, "The composer": `/files` reads a file in the pager;
 * "The transcript": `d` and `/diff`): lines of styled spans cut to the
 * pager's width, every character kept (a line of code is not reflowed at
 * its spaces). Widths are terminal cells as Ink measures them
 * (`string-width`): a wide character (CJK, most emoji) takes two, and a
 * character is never parted from its combining marks at a wrap. Pure.
 *
 * - **A file** is plain text: tabs expanded to the next stop of eight,
 *   control characters dropped (C0, DEL and C1, which a terminal reading
 *   C1 in UTF-8 takes as `ESC [` and the rest), so nothing in it can move
 *   the cursor or recolour the screen.
 * - **A diff with no tool of the user's** is coloured as `git diff` colours
 *   one: headers bold, hunk lines cyan, additions green, removals red; under
 *   truecolour an addition and a removal are drawn on the theme's bands.
 * - **A diff tool's answer** keeps the colours and attributes it wrote
 *   (SGR); every other escape it wrote (a hyperlink, an erase, a charset
 *   switch), in its ESC or its C1 form, is dropped, and so is any other
 *   control character.
 */

const TAB = 8;

const GRAPHEMES = new Intl.Segmenter();

/** The cells of each grapheme met, remembered: a page of text meets few distinct ones. */
const WIDTHS = new Map<string, number>();
const widthOf = (grapheme: string): number => {
  let cells = WIDTHS.get(grapheme);
  if (cells === undefined) {
    cells = stringWidth(grapheme);
    if (WIDTHS.size < 4096) WIDTHS.set(grapheme, cells);
  }
  return cells;
};

/** Printable ASCII and tabs: a character a grapheme of one cell (a tab's cells are its stop's), measured without segmenting. */
const ASCII = /^[\t -~]*$/;

/** `text`'s graphemes (a character with its combining marks, an emoji sequence), each with the cells it takes. */
const cellsOf = (text: string): { readonly grapheme: string; readonly cells: number }[] =>
  ASCII.test(text)
    ? Array.from(text, (grapheme) => ({ grapheme, cells: grapheme === "\t" ? 0 : 1 }))
    : Array.from(GRAPHEMES.segment(text), ({ segment }) => ({ grapheme: segment, cells: widthOf(segment) }));

/**
 * Spans cut into lines of at most `width` cells, a grapheme never split (one wider than the width alone on its line); an
 * empty logical line is one empty line.
 */
const cut = (spans: readonly Span[], width: number): Span[][] => {
  const room = Math.max(1, width);
  const out: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  for (const span of spans) {
    let text = "";
    for (const { grapheme, cells } of cellsOf(span.text)) {
      if (used > 0 && used + cells > room) {
        if (text.length > 0) line.push({ ...span, text });
        out.push(line);
        line = [];
        used = 0;
        text = "";
      }
      text += grapheme;
      used += cells;
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

/** `text`'s tabs expanded to the next stop, measured in cells from the line's start, `from` cells before `text`. */
const expandTabs = (text: string, from = 0): string => {
  let out = "";
  let column = from;
  for (const { grapheme, cells } of cellsOf(text)) {
    if (grapheme === "\t") {
      const pad = TAB - (column % TAB);
      out += " ".repeat(pad);
      column += pad;
    } else {
      out += grapheme;
      column += cells;
    }
  }
  return out;
};

/** C0 but the tab and the newline, DEL, and C1 (U+0080 to U+009F: U+009B is CSI, U+009D OSC to a terminal reading C1 in UTF-8). */
// eslint-disable-next-line no-control-regex -- the control characters are what is being removed.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** A line of text as a page draws it: its carriage return and control characters gone, its tabs expanded. */
const cleaned = (line: string): string => expandTabs(line.replace(/\r$/, "")).replace(CONTROLS, "");

const pageLines = (logical: readonly (readonly Span[])[], width: number, name: string): Line[] =>
  logical.flatMap((spans, index) => cut(spans, width).map((line): Line => ({ row: `${name}:${index}`, spans: line })));

/** A file's text as the pager draws it. */
export const plainPage = (text: string, width: number): Line[] =>
  pageLines(
    text.split("\n").map((line) => {
      const clean = cleaned(line);
      return clean.length === 0 ? [] : [{ text: clean }];
    }),
    width,
    "file",
  );

/** What a line of a unified diff is, as `git diff` colours it. */
type DiffLine = "header" | "hunk" | "added" | "removed" | "context";

const diffLineOf = (line: string): DiffLine => {
  if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
};

/** How each is drawn when no tool of the user's colours it, as `git diff` would: headers bold, hunk lines cyan, additions green, removals red. */
const DIFF_STYLES: Readonly<Record<DiffLine, Omit<Span, "text">>> = {
  header: { bold: true },
  hunk: { color: TERMINAL_ROLES.machine },
  added: { color: TERMINAL_ROLES.success },
  removed: { color: TERMINAL_ROLES.danger },
  context: {},
};

/** The SGR git writes for each (its `color.diff` defaults). */
const GIT_SGR: Readonly<Record<DiffLine, string | undefined>> = { header: "1", hunk: "36", added: "32", removed: "31", context: undefined };

/** The band an addition and a removal are drawn on, which the theme gives a truecolour terminal (#392). */
const DIFF_BANDS: Readonly<Record<DiffLine, DiffBand | undefined>> = { header: undefined, hunk: undefined, added: "added", removed: "removed", context: undefined };

/** A unified diff coloured as `git diff --color` colours one, for a tool that reads the colours (diff-so-fancy). */
export const colouredDiff = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const sgr = GIT_SGR[diffLineOf(line)];
      return sgr === undefined ? line : `\u001B[${sgr}m${line}\u001B[m`;
    })
    .join("\n");

/** A unified diff, coloured as a diff, each addition and removal on its band. */
export const diffPage = (text: string, width: number): Line[] =>
  text.split("\n").flatMap((raw, index) => {
    const clean = cleaned(raw);
    const kind = diffLineOf(clean);
    const band = DIFF_BANDS[kind];
    return cut(clean.length === 0 ? [] : [{ ...DIFF_STYLES[kind], text: clean }], width).map((spans): Line => ({ row: `diff:${index}`, spans, ...(band && { band }) }));
  });

type Style = { -readonly [K in keyof Omit<Span, "text">]: Span[K] };

/** One parameter of an SGR sequence: its code, then its colon sub-parameters (an empty one undefined). */
type Param = readonly (number | undefined)[];

/** An extended colour's arguments (after 38, 48 or 58): `5;n` a palette entry, `2;r;g;b` (or `2:[space]:r:g:b`) a true colour. */
const extended = (args: Param): string | undefined => {
  if (args[0] === 5) return paletteColour(args[1] ?? 0);
  if (args[0] === 2) {
    // The colon form may carry a colour space before the three values (`38:2::r:g:b`, `38:2:0:r:g:b`); the rest take the last three.
    const [r = 0, g = 0, b = 0] = args.length >= 5 ? args.slice(-3) : args.slice(1, 4);
    return colourOf({ palette: false, rgb: true, value: (r << 16) | (g << 8) | b });
  }
  return undefined;
};

/**
 * The style after one SGR sequence's parameters (`raw`, as written between
 * `CSI` and `m`), from `style`. Parameters are separated by `;`; a
 * parameter's `:` parts are its sub-parameters (`4:3` a curly underline,
 * `38:2::r:g:b`), never codes of their own. The extended colours' `;` form
 * takes the parameters after it as its arguments, or the next one's
 * sub-parameters when it has them (`38;2:r:g:b`); the underline colour (58,
 * 59), which a cell here has no carrier for, is passed over with them.
 */
const applySgr = (style: Style, raw: string): Style => {
  const params: Param[] = raw.split(";").map((param) => param.split(":").map((part) => (part === "" ? undefined : Number(part))));
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const param = params[i] ?? [];
    const p = param[0] ?? 0;
    /**
     * The extended colour at `i`: from its sub-parameters when it has them;
     * else from the next parameter's when that has them (`38;2:r:g:b`, the
     * mixed form xterm accepts), taking that one; else from the parameters
     * after it, which it takes.
     */
    const colour = (): string | undefined => {
      if (param.length > 1) return extended(param.slice(1));
      const following = params[i + 1];
      if (following !== undefined && following.length > 1) {
        i += 1;
        return extended(following);
      }
      const mode = following?.[0];
      const taken = mode === 5 ? 2 : mode === 2 ? 4 : 0;
      const args = params.slice(i + 1, i + 1 + taken).map((q) => q[0]);
      i += taken;
      return extended(args);
    };
    if (p === 0) for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) {
      // `4:0` is no underline; `4:1` to `4:5` are its kinds (single, double, curly, dotted, dashed), each an underline here.
      if (param[1] === 0) delete next.underline;
      else next.underline = true;
    } else if (p === 7) next.inverse = true;
    else if (p === 9) next.strikethrough = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p === 29) delete next.strikethrough;
    else if (p >= 30 && p <= 37) next.color = paletteColour(p - 30);
    else if (p >= 90 && p <= 97) next.color = paletteColour(p - 90 + 8);
    else if (p >= 40 && p <= 47) next.background = paletteColour(p - 40);
    else if (p >= 100 && p <= 107) next.background = paletteColour(p - 100 + 8);
    else if (p === 38) {
      const value = colour();
      if (value === undefined) delete next.color;
      else next.color = value;
    } else if (p === 48) {
      const value = colour();
      if (value === undefined) delete next.background;
      else next.background = value;
    } else if (p === 58) colour();
    else if (p === 39) delete next.color;
    else if (p === 49) delete next.background;
  }
  return next;
};

/**
 * An escape sequence (ECMA-48): a CSI (`ESC [` or U+009B) with its
 * parameter bytes (group 1, a private marker `<=>?` among them) and
 * intermediate bytes (group 2), and its final byte (group 3), to tell SGR,
 * one without a final byte (cut short by a control, whose meaning stands, or
 * by the end of the answer) ending where its bytes do, so its parameters are
 * never text;
 * a control string, an OSC (`ESC ]` or U+009D) to BEL or ST, a DCS, SOS, PM
 * or APC (`ESC P`, `ESC X`, `ESC ^`, `ESC _` or their C1 forms) to ST, ST
 * being `ESC \` or U+009C, the string running across lines, cut short by
 * another escape (read as itself), and when never terminated running to
 * the end; an escape with intermediate bytes (`ESC ( B`, which `tput sgr0`
 * writes); any other two-byte one, its final byte anywhere in `0` to `~`
 * (`ESC 7`, `ESC =`, `ESC c` as well as `ESC M`).
 */
const ESCAPE =
  // eslint-disable-next-line no-control-regex -- escape sequences are what is being read.
  /(?:\u001B\[|\u009B)([0-?]*)([ -/]*)([@-~])?|(?:\u001B\]|\u009D)[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?|(?:\u001B[PX^_]|[\u0090\u0098\u009E\u009F])[^\u001B\u009C]*(?:\u001B\\|\u009C)?|\u001B(?:[ -/]+[0-~]|[0-~])/g;

/** SGR: final byte `m`, no intermediate bytes, and parameters of digits, `;` and `:` only (a private marker makes it another sequence). */
const isSgr = (params: string | undefined, intermediates: string | undefined, final: string | undefined): params is string =>
  final === "m" && intermediates === "" && params !== undefined && /^[0-9;:]*$/.test(params);

/**
 * Text a tool coloured with escape sequences, as the pager draws it. The
 * escapes are read over the whole text, not line by line, since a control
 * string runs across lines.
 */
export const sgrPage = (text: string, width: number): Line[] => {
  let style: Style = {};
  let spans: Span[] = [];
  const logical: Span[][] = [spans];
  let column = 0;
  /** Text between two escapes, in the style then; each newline in it starts the next line. */
  const add = (piece: string) =>
    piece.split("\n").forEach((part, index) => {
      if (index > 0) {
        spans = [];
        logical.push(spans);
        column = 0;
      }
      // A carriage return is among the controls dropped.
      const clean = expandTabs(part.replace(CONTROLS, ""), column);
      column += ASCII.test(clean) ? clean.length : stringWidth(clean);
      if (clean.length === 0) return;
      const last = spans.at(-1);
      if (last && sameStyle(last, style)) spans[spans.length - 1] = { ...last, text: last.text + clean };
      else spans.push({ ...style, text: clean });
    });
  let at = 0;
  for (const match of text.matchAll(ESCAPE)) {
    add(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (isSgr(match[1], match[2], match[3])) style = applySgr(style, match[1]);
  }
  add(text.slice(at));
  return pageLines(logical, width, "tool");
};
