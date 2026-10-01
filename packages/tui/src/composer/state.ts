import type { AttachmentInput, SkillReadiness } from "@agent-harness/contracts";
import {
  EMPTY_EDITOR,
  backspace,
  continueLine,
  editorOf,
  endsWithContinuation,
  insert,
  left,
  newline,
  replaceAll,
  right,
  type EditorState,
} from "./editor.js";
import type { HistoryMatch } from "./history.js";
import { fuzzyMatch, matchCommands, mentionAt, replaceMention, type FileMatch, type FrecencyLike, type Mention, type SlashMenuRow } from "@agent-harness/client-runtime";
import { classifyPaste, expandChip, pasteMarker, type PasteClassification } from "./paste-kind.js";
import { expand, expandInText, snippetAt, type Expansion, type SlotRange, type SnippetTemplate, type SnippetToken } from "./snippets.js";

/**
 * The composer as data (docs/specs/tui.md, "The composer"): the composer's
 * rules kept and its state lifted out of the component, so every rule is a
 * function a test can call and the keys reach it through the shared action
 * list. The buffer is `editor.ts`'s; around it:
 *
 * - **Paste chips**: a paste of more than three lines or 800 characters
 *   stands in the text as one marker, `[Pasted #1 · 412 lines · Node stack
 *   trace from app.tsx:1442]` (`paste-kind.ts` reads what it is), and becomes
 *   its text again on the way out, fenced when its kind asks. An image off the
 *   clipboard is `[Image #1]` in the text and an attachment beside it. A chip
 *   exists exactly as long as its marker is in the text; Backspace takes one
 *   whole. Numbers are never reused within a message.
 * - **Popups**, one at a time and in the order the sigils are reached: the
 *   slash menu while the text is one word beginning with `/`, the paths `@`
 *   names (the session's `files.list`, scored by the carried fuzzy scorer),
 *   the snippets `;;` names. The highlighted row is remembered against the
 *   token it was chosen over, so an edit falls back to the first row.
 * - **History**: ↑ on the first line walks older prompts (the session's, then
 *   the workspace's, then all), ↓ back to the text that was there; Ctrl+R
 *   searches them. A walk lasts exactly as long as the text it put in the box.
 * - **Snippet stops**: an expansion's holes, Tab to the next, Shift+Tab back,
 *   a default replaced by the first thing typed into it.
 * - **The stash**: Ctrl+S sets the text aside and gives it back.
 *
 * What is sent (`outgoing`) is the text with its chips expanded, and the
 * attachments: the images pasted and the files `/attach` read.
 */

/** A marker in the text standing for more than it says. */
export type Chip =
  | { readonly kind: "paste"; readonly marker: string; readonly text: string; readonly paste: PasteClassification }
  | { readonly kind: "image"; readonly marker: string; readonly attachment: AttachmentInput };

/** A walk through the history, alive while the box holds the text it put there. */
export interface Walk {
  readonly texts: readonly string[];
  /** -1 is the text the walk began from; 0 the newest prompt. */
  readonly position: number;
  readonly origin: string;
  readonly shown: string;
}

/** An open reverse search: the query, the scope it looks in, the match showing, and the buffer it displaced. */
export interface Search {
  readonly query: string;
  readonly scope: number;
  readonly at: number;
  readonly saved: EditorState;
}

/** The holes an expansion left, counted in `text`. */
export interface Stops {
  readonly slots: readonly SlotRange[];
  readonly at: number;
  readonly final?: number;
  readonly text: string;
}

export interface ComposerState {
  readonly editor: EditorState;
  readonly chips: readonly Chip[];
  /** The last chip number given in this message. */
  readonly numbered: number;
  /** Files `/attach` read for the next message. */
  readonly attached: readonly AttachmentInput[];
  /** The highlighted popup row, and the popup it was chosen in. */
  readonly highlight: { readonly popup: string; readonly index: number } | null;
  readonly walk: Walk | null;
  readonly search: Search | null;
  readonly stash: EditorState | null;
  readonly stops: Stops | null;
}

export const EMPTY_COMPOSER: ComposerState = {
  editor: EMPTY_EDITOR,
  chips: [],
  numbered: 0,
  attached: [],
  highlight: null,
  walk: null,
  search: null,
  stash: null,
  stops: null,
};

/** A composer holding `text`, the cursor at its end: a session's saved text, or a queued message given back. */
export const composerOf = (text: string): ComposerState => ({ ...EMPTY_COMPOSER, editor: editorOf(text) });

/** A paste past either stands in the text as a chip. */
export const PASTE_CHIP_LINES = 3;
export const PASTE_CHIP_CHARS = 800;

/* ------------------------------------------------------------------------ */
/* What is sent                                                              */
/* ------------------------------------------------------------------------ */

/** The chips whose markers are still in the text. */
const liveChips = (state: ComposerState): Chip[] => state.chips.filter((chip) => state.editor.text.includes(chip.marker));

/** The text with every paste chip expanded back into what it stood for; image markers stay, naming where the picture was meant. */
export const expandedText = (state: ComposerState): string =>
  liveChips(state).reduce((text, chip) => (chip.kind === "paste" ? expandChip(text, chip.marker, chip.text, chip.paste) : text), state.editor.text);

/** What Enter sends: the text with its chips expanded, and the images and files that go with it. */
export const outgoing = (state: ComposerState): { readonly text: string; readonly attachments: readonly AttachmentInput[] } => ({
  text: expandedText(state).trim(),
  attachments: [...liveChips(state).flatMap((chip) => (chip.kind === "image" ? [chip.attachment] : [])), ...state.attached],
});

/** Sent: an empty box, its chips and files gone; the kill ring and the stash stay. */
export const sent = (state: ComposerState): ComposerState => ({ ...EMPTY_COMPOSER, editor: { ...EMPTY_EDITOR, kill: state.editor.kill }, stash: state.stash });

/* ------------------------------------------------------------------------ */
/* Typing and pasting                                                        */
/* ------------------------------------------------------------------------ */

/** The editor changed: the state around it that the change leaves standing. */
const edited = (state: ComposerState, editor: EditorState): ComposerState => ({ ...state, editor });

/**
 * Text typed at the box. A pending snippet default under the cursor is
 * replaced by the first thing typed into it.
 */
export const typed = (state: ComposerState, text: string): ComposerState => {
  const stop = pendingStop(state);
  const base = stop ? replaceRange(state.editor, stop.start, stop.end, "") : state.editor;
  const next = edited(state, insert(base, text));
  return stop && state.stops ? { ...next, stops: shifted(state.stops, next.editor.text) } : next;
};

/** A paste: a short one inserted as typed, a long one as a chip. */
export const pasted = (state: ComposerState, text: string): ComposerState => {
  const clean = text.replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").length;
  if (lines <= PASTE_CHIP_LINES && clean.length <= PASTE_CHIP_CHARS) return typed(state, clean);
  const number = state.numbered + 1;
  const paste = classifyPaste(clean);
  const marker = pasteMarker(number, lines, paste.label);
  return { ...edited(state, insert(state.editor, marker)), chips: [...state.chips, { kind: "paste", marker, text: clean, paste }], numbered: number };
};

/** An image off the clipboard: `[Image #n]` where the cursor is, and the attachment beside it. */
export const pastedImage = (state: ComposerState, attachment: (number: number) => AttachmentInput): ComposerState => {
  const number = state.numbered + 1;
  const marker = `[Image #${number}]`;
  return { ...edited(state, insert(state.editor, marker)), chips: [...state.chips, { kind: "image", marker, attachment: attachment(number) }], numbered: number };
};

/** Backspace: a chip the cursor stands just after goes whole, anything else one character. */
export const rubbedOut = (state: ComposerState): ComposerState => {
  const before = state.editor.text.slice(0, state.editor.cursor);
  const chip = liveChips(state).find((c) => before.endsWith(c.marker));
  if (chip) return edited(state, replaceRange(state.editor, state.editor.cursor - chip.marker.length, state.editor.cursor, ""));
  return edited(state, backspace(state.editor));
};

/** Enter on a line ending in a backslash (`\ Enter`): the backslash goes and a line opens; false when the line does not end in one. */
export const continued = (state: ComposerState): ComposerState | false => (endsWithContinuation(state.editor) ? edited(state, continueLine(state.editor)) : false);

/** A newline instead of sending. */
export const brokenLine = (state: ComposerState): ComposerState => edited(state, newline(state.editor));

/** The whole text replaced, undoably: a history entry, a recalled command, an edit made in `$EDITOR`. */
export const replaced = (state: ComposerState, text: string): ComposerState => edited(state, replaceAll(state.editor, text));

/** `text` with `[from, to)` replaced by `by`, as an undoable edit, the cursor after it. */
const replaceRange = (editor: EditorState, from: number, to: number, by: string): EditorState =>
  cursorAt(replaceAll(editor, editor.text.slice(0, from) + by + editor.text.slice(to)), from + by.length);

/** The buffer with its cursor walked to `offset` by the editor's own steps, so it never lands inside a surrogate pair. */
export const cursorAt = (editor: EditorState, offset: number): EditorState => {
  let next = editor;
  while (next.cursor > offset) {
    const back = left(next);
    if (back.cursor === next.cursor) break;
    next = back;
  }
  while (next.cursor < offset) {
    const on = right(next);
    if (on.cursor === next.cursor) break;
    next = on;
  }
  return next;
};

/* ------------------------------------------------------------------------ */
/* Popups                                                                    */
/* ------------------------------------------------------------------------ */

/** A row of the slash menu: a command this terminal answers, a skill of the open session's set, or the provider's own (#503). */
export interface CommandRow extends SlashMenuRow {
  readonly readiness?: SkillReadiness;
}

export type Popup =
  | { readonly kind: "commands"; readonly key: string; readonly rows: readonly CommandRow[] }
  | { readonly kind: "mentions"; readonly key: string; readonly mention: Mention; readonly rows: readonly FileMatch[]; readonly loading: boolean }
  | { readonly kind: "snippets"; readonly key: string; readonly token: SnippetToken; readonly rows: readonly SnippetTemplate[] };

export interface PopupSources {
  readonly commands: readonly CommandRow[];
  /** The workspace's paths; null while the listing has not come. */
  readonly paths: readonly string[] | null;
  readonly frecency?: FrecencyLike;
  readonly snippets: readonly SnippetTemplate[];
}

/** Rows offered at once. */
export const POPUP_ROWS = 8;

/** Whether `name` holds `query`'s letters in order. */
const subsequence = (query: string, name: string): boolean => {
  let at = 0;
  for (const char of name) if (char === query[at]) at++;
  return at === query.length;
};

/**
 * The popup the text and cursor open, if any: the slash menu while the text
 * is one word starting with `/`, else the paths an `@` token names, else the
 * snippets a `;;` token names. A reverse search holds the keyboard; no popup
 * opens under it.
 */
export const popupOf = (state: ComposerState, sources: PopupSources): Popup | null => {
  if (state.search !== null) return null;
  const { text, cursor } = state.editor;
  const command = /^\/(\S*)$/.exec(text);
  if (command && cursor === text.length) {
    const rows = matchCommands(command[1] ?? "", sources.commands);
    return rows.length === 0 ? null : { kind: "commands", key: `commands ${text}`, rows: rows.slice(0, POPUP_ROWS) };
  }
  const mention = mentionAt(text, cursor);
  if (mention) {
    const rows = sources.paths === null ? [] : fuzzyMatch(mention.query, sources.paths, { limit: POPUP_ROWS, ...(sources.frecency && { frecency: sources.frecency }) });
    return { kind: "mentions", key: `mentions ${mention.start} ${mention.query}`, mention, rows, loading: sources.paths === null };
  }
  const token = snippetAt(text, cursor);
  if (token) {
    const rows = sources.snippets.filter((s) => subsequence(token.name, s.name)).slice(0, POPUP_ROWS);
    return rows.length === 0 ? null : { kind: "snippets", key: `snippets ${token.start} ${token.name}`, token, rows };
  }
  return null;
};

/** How many rows a popup offers. */
export const popupSize = (popup: Popup): number => popup.rows.length;

/** The highlighted row of `popup`: the one chosen in it, else the first; -1 when it offers none. */
export const highlighted = (state: ComposerState, popup: Popup): number => {
  const size = popupSize(popup);
  if (size === 0) return -1;
  return state.highlight?.popup === popup.key ? Math.min(Math.max(state.highlight.index, 0), size - 1) : 0;
};

/** The highlight moved by `step`, clamped. */
export const moveHighlight = (state: ComposerState, popup: Popup, step: number): ComposerState => ({
  ...state,
  highlight: { popup: popup.key, index: Math.min(Math.max(highlighted(state, popup) + step, 0), Math.max(0, popupSize(popup) - 1)) },
});

/** The highlighted path written over the `@` token, with a space after it so the next word can just be typed. */
export const acceptMention = (state: ComposerState, popup: Extract<Popup, { kind: "mentions" }>): { readonly state: ComposerState; readonly path: string } | null => {
  const row = popup.rows[highlighted(state, popup)];
  if (!row) return null;
  const written = replaceMention(state.editor.text, popup.mention.start, popup.mention.end, `@${row.path}`);
  return { state: { ...state, editor: cursorAt(replaceAll(state.editor, written.text), written.cursor), highlight: null }, path: row.path };
};

/** The highlighted command filled in: its name, and a space when it takes arguments. */
export const acceptCommand = (state: ComposerState, popup: Extract<Popup, { kind: "commands" }>): ComposerState => {
  const row = popup.rows[highlighted(state, popup)];
  if (!row) return state;
  const takes = row.usage.includes(" ");
  return { ...replaced(state, `/${row.name}${takes ? " " : ""}`), highlight: null };
};

/** The highlighted command as Enter runs it: its name typed out in full. */
export const chosenCommand = (state: ComposerState, popup: Extract<Popup, { kind: "commands" }>): CommandRow | undefined => popup.rows[highlighted(state, popup)];

/** The highlighted snippet expanded over its `;;` token, its holes becoming stops. */
export const acceptSnippet = (state: ComposerState, popup: Extract<Popup, { kind: "snippets" }>): ComposerState => {
  const row = popup.rows[highlighted(state, popup)];
  if (!row) return state;
  const written = expandInText(state.editor.text, popup.token.start, popup.token.end, expand(row.body));
  return withExpansion(state, written);
};

/** A snippet expanded over the whole text (`/snip name words`), undoably. */
export const expandedSnippet = (state: ComposerState, body: string, words: readonly string[]): ComposerState => withExpansion(state, expand(body, words));

const withExpansion = (state: ComposerState, expansion: Expansion): ComposerState => ({
  ...state,
  editor: cursorAt(replaceAll(state.editor, expansion.text), expansion.cursor),
  highlight: null,
  stops: expansion.slots.length === 0 ? null : { slots: expansion.slots, at: 0, text: expansion.text, ...(expansion.final !== undefined && { final: expansion.final }) },
});

/* ------------------------------------------------------------------------ */
/* Snippet stops                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The stops moved to where they are in `text`, or null when the edit was not
 * one they survive: everything outside the current hole must be where it
 * was, so the hole grew or shrank and the rest slid.
 */
export const shifted = (stops: Stops, text: string): Stops | null => {
  if (stops.text === text) return stops;
  const current = stops.slots[stops.at];
  if (current === undefined) return null;
  const old = stops.text;
  const delta = text.length - old.length;
  const end = current.end + delta;
  if (end < current.start) return null;
  if (text.slice(0, current.start) !== old.slice(0, current.start)) return null;
  if (text.slice(end) !== old.slice(current.end)) return null;
  const moved: Stops = {
    text,
    at: stops.at,
    slots: stops.slots.map((slot, index) => (index < stops.at ? slot : index === stops.at ? { start: slot.start, end } : { start: slot.start + delta, end: slot.end + delta })),
  };
  return stops.final === undefined ? moved : { ...moved, final: stops.final >= current.end ? stops.final + delta : stops.final };
};

/** The stops as the text stands now; null once an edit left them behind. */
export const liveStops = (state: ComposerState): Stops | null => (state.stops === null ? null : shifted(state.stops, state.editor.text));

/** A default still standing under the cursor: the text is as the stop was counted and the cursor at the front of its hole. */
const pendingStop = (state: ComposerState): SlotRange | null => {
  const stops = state.stops;
  if (stops === null || stops.text !== state.editor.text) return null;
  const slot = stops.slots[stops.at];
  return slot !== undefined && state.editor.cursor === slot.start && slot.end > slot.start ? slot : null;
};

/** Tab (or Shift+Tab with `-1`) in a snippet: the next hole, then `$0`, then the stops put away; false with no stops. */
export const walkStops = (state: ComposerState, step: 1 | -1): ComposerState | false => {
  const stops = liveStops(state);
  if (stops === null) return false;
  const target = stops.at + step;
  if (target < 0) return state;
  const slot = stops.slots[target];
  if (slot !== undefined) return { ...state, editor: cursorAt(state.editor, slot.start), stops: { ...stops, at: target } };
  // Past the last hole: `$0`, or the end of the hole it was in, and the stops go.
  const current = stops.slots[stops.at];
  return { ...state, editor: cursorAt(state.editor, stops.final ?? current?.end ?? state.editor.text.length), stops: null };
};

/* ------------------------------------------------------------------------ */
/* History                                                                   */
/* ------------------------------------------------------------------------ */

/** The walk still standing: the box holds the text it last wrote. */
export const liveWalk = (state: ComposerState): Walk | null => (state.walk !== null && state.walk.shown === state.editor.text ? state.walk : null);

/** ↑ (-1 older, from the newest) or ↓ through the history's `texts`; false when there is nowhere to go. */
export const walked = (state: ComposerState, texts: readonly string[], step: 1 | -1): ComposerState | false => {
  const walk = liveWalk(state) ?? { texts, position: -1, origin: state.editor.text, shown: state.editor.text };
  const position = step === 1 ? Math.min(walk.position + 1, walk.texts.length - 1) : Math.max(walk.position - 1, -1);
  if (position === walk.position) return false;
  const text = position === -1 ? walk.origin : (walk.texts[position] ?? walk.origin);
  return { ...replaced(state, text), walk: { ...walk, position, shown: text } };
};

/** Where a walk stands, for the hint: which of how many. */
export const walkPlace = (state: ComposerState): { readonly at: number; readonly of: number } | null => {
  const walk = liveWalk(state);
  return walk === null || walk.position < 0 ? null : { at: walk.position + 1, of: walk.texts.length };
};

/** The reverse search opened (Ctrl+R), the buffer set aside whole so Esc gives it back. */
export const searching = (state: ComposerState): ComposerState => ({ ...state, search: { query: "", scope: 0, at: 0, saved: state.editor } });

/** The search's query, scope or place changed, and the box showing the match. */
export const searched = (state: ComposerState, change: Partial<Pick<Search, "query" | "scope" | "at">>, matches: (search: Search) => readonly HistoryMatch[]): ComposerState => {
  if (state.search === null) return state;
  const search = { ...state.search, ...change };
  const found = matches(search);
  const at = Math.min(search.at, Math.max(0, found.length - 1));
  const match = found[at];
  return { ...state, search: { ...search, at }, editor: match ? editorOf(match.text) : search.saved };
};

/** The search closed: keeping the match to edit, or (`cancel`) with the buffer it displaced back. */
export const searchClosed = (state: ComposerState, cancel: boolean): ComposerState =>
  state.search === null ? state : { ...state, editor: cancel ? state.search.saved : state.editor, search: null };

/* ------------------------------------------------------------------------ */
/* The stash                                                                 */
/* ------------------------------------------------------------------------ */

/** Ctrl+S outside a search: the text set aside; with the box empty, given back; with both, swapped. False with nothing either way. */
export const stashed = (state: ComposerState): ComposerState | false => {
  const holding = state.editor.text.length > 0;
  if (!holding && state.stash === null) return false;
  return { ...state, editor: state.stash ?? EMPTY_EDITOR, stash: holding ? state.editor : null };
};
