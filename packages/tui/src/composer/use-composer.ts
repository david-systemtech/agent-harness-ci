import { useReducer, useRef } from "react";
import type { AttachmentInput } from "@agent-harness/contracts";
import type { KeyActionId } from "@agent-harness/contracts";
import { direction, type Handler, type Keymap } from "../keys.js";
import { attachmentFromBytes } from "./attachments.js";
import type { ClipboardImage } from "./clipboard.js";
import {
  bufferEnd,
  bufferStart,
  deleteForward,
  deleteWordLeft,
  deleteWordRight,
  down,
  killToLineEnd,
  killToLineStart,
  left,
  lineEnd,
  lineStart,
  onFirstLine,
  onLastLine,
  right,
  undo,
  up,
  wordLeft,
  wordRight,
  yank,
  type EditorState,
} from "./editor.js";
import type { HistoryMatch, HistoryScope } from "./history.js";
import {
  EMPTY_COMPOSER,
  acceptCommand,
  acceptMention,
  acceptSnippet,
  brokenLine,
  chosenCommand,
  continued,
  expandedText,
  highlighted,
  liveStops,
  moveHighlight,
  outgoing,
  pasted,
  pastedImage,
  popupOf,
  replaced,
  rubbedOut,
  searchClosed,
  searched,
  searching,
  sent,
  stashed,
  typed,
  walkPlace,
  walkStops,
  walked,
  type ComposerState,
  type Popup,
  type PopupSources,
} from "./state.js";

/**
 * The composer's keys (docs/specs/tui.md, "The composer" and "Shortcuts"):
 * every `composer.*` action this build answers, over the pure state of
 * `state.ts`. The state is held in a ref as well as rendered, so two keys
 * arriving before a render (a fast typist, a paste split across reads) each
 * see what the one before left; a handler that has nothing to do declines,
 * and the next context in the lookup takes the key (Tab moves the focus when
 * no popup wants it).
 */

/** The composer's actions this build answers: every one has its handler below (the table is typed by this list). */
export const COMPOSER_KEYS = [
  "composer.send",
  "composer.newline",
  "composer.continueLine",
  "composer.navigate",
  "composer.command.menu",
  "composer.complete",
  "composer.slot.back",
  "composer.paste",
  "composer.editor",
  "composer.line.start",
  "composer.line.end",
  "composer.buffer.start",
  "composer.buffer.end",
  "composer.word.back",
  "composer.word.forward",
  "composer.word.deleteBack",
  "composer.word.deleteForward",
  "composer.cut.toStart",
  "composer.cut.toEnd",
  "composer.yank",
  "composer.undo",
  "composer.backspace",
  "composer.history.search",
  "composer.history.scopeOrStash",
] as const satisfies readonly KeyActionId[];

export type ComposerKey = (typeof COMPOSER_KEYS)[number];

/** The clipboard reads Ctrl+V makes; the real clipboard unless a test hands in another. */
export interface ComposerClipboard {
  readImage(): Promise<ClipboardImage | null>;
  readText(): Promise<string | null>;
}

/** The history's two reads. */
export interface HistoryReader {
  recent(scope: HistoryScope): readonly string[];
  search(query: string, scope: HistoryScope, limit?: number): readonly HistoryMatch[];
}

export interface ComposerHost {
  readonly keymap: Keymap;
  readonly sources: PopupSources;
  readonly history: HistoryReader | undefined;
  /** The scopes ↑ prefers and Ctrl+S cycles, best first, each with its name for the search row. */
  readonly scopes: readonly { readonly name: string; readonly scope: HistoryScope }[];
  readonly clipboard: ComposerClipboard;
  /** Ctrl+G: the text in `$VISUAL` or `$EDITOR`, and back the edited text; undefined when the edit was abandoned or failed (said by the host). */
  readonly editText: (text: string) => Promise<string | undefined>;
  /** One line under the composer. */
  readonly say: (line: string) => void;
  /**
   * Enter with something typed: the host runs it, a command or a message.
   * `raw` is the text as it stands in the box (a command is read from it),
   * `message` what would go to the agent. True when it went, and the box
   * empties.
   */
  readonly submit: (raw: string, message: { readonly text: string; readonly attachments: readonly AttachmentInput[] }) => boolean;
  /** A path chosen from the `@` list, for the pick memory. */
  readonly picked: (path: string) => void;
  /** Whether the composer takes keys now (it has the focus and no card does). */
  readonly active: boolean;
}

export interface Composer {
  readonly state: ComposerState;
  readonly popup: Popup | null;
  /** The text as it goes out and as the session's draft holds it: chips expanded. */
  readonly text: string;
  /** The same, as it is now rather than at the last render: for an effect that runs after a key changed it. */
  current(): string;
  readonly handlers: Readonly<Record<ComposerKey, Handler>>;
  /** Characters typed, not keys: into the search query while one is open, else the text. */
  type(text: string): void;
  /** A bracketed paste. */
  paste(text: string): void;
  /** The plain editing keys the action list leaves implicit: ←, →, Delete. */
  edit(key: "left" | "right" | "delete"): boolean;
  /** Replaces the whole state: a session's saved text, a recalled command. */
  set(state: ComposerState): void;
  /** Whether a reverse search is open (Esc closes it before anything else hears Esc). */
  readonly searching: boolean;
  /** Closes the reverse search, giving back the text it displaced. */
  cancelSearch(): void;
  /** Adds a file `/attach` read to the next message. */
  attach(attachment: AttachmentInput): void;
}

export const useComposer = (host: ComposerHost): Composer => {
  const box = useRef<ComposerState>(EMPTY_COMPOSER);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(host);
  latest.current = host;

  const set = (next: ComposerState) => {
    if (next === box.current) return;
    box.current = next;
    redraw();
  };
  /** Applies `change` to the state as it is now; false (the key declined) when it answers false. */
  const update = (change: (state: ComposerState) => ComposerState | false): false | undefined => {
    const next = change(box.current);
    if (next === false) return false;
    set(next);
    return undefined;
  };
  const moved = (move: (editor: EditorState) => EditorState) => () => update((s) => ({ ...s, editor: move(s.editor) }));
  const popupNow = () => popupOf(box.current, latest.current.sources);

  const matchesOf = (query: string, scope: number): readonly HistoryMatch[] => {
    const { history, scopes } = latest.current;
    const chosen = scopes[scope]?.scope;
    return history === undefined || chosen === undefined ? [] : history.search(query, chosen);
  };
  /** The prompts ↑ walks: the first scope that has any, as Artemis falls through from the folder to everything. */
  const walkTexts = (): readonly string[] => {
    const { history, scopes } = latest.current;
    if (history === undefined) return [];
    for (const { scope } of scopes) {
      const texts = history.recent(scope);
      if (texts.length > 0) return texts;
    }
    return [];
  };

  const submitNow = (): boolean => {
    const state = box.current;
    const raw = state.editor.text;
    const message = outgoing(state);
    if (raw.trim().length === 0 && message.attachments.length === 0) return false;
    if (latest.current.submit(raw, message)) set(sent(box.current));
    return true;
  };

  const handlers: Record<ComposerKey, Handler> = {
    "composer.send": () => {
      const state = box.current;
      if (state.search !== null) {
        set(searchClosed(state, false));
        return void submitNow();
      }
      const popup = popupNow();
      if (popup?.kind === "mentions") {
        const accepted = acceptMention(state, popup);
        if (accepted) {
          latest.current.picked(accepted.path);
          return void set(accepted.state);
        }
      }
      if (popup?.kind === "snippets") return void set(acceptSnippet(state, popup));
      if (popup?.kind === "commands") {
        // Run the highlighted command as if its name had been typed out in full.
        const row = chosenCommand(state, popup);
        if (row) set(replaced(state, `/${row.name}`));
      }
      if (!submitNow()) return false;
    },
    "composer.newline": () => update(brokenLine),
    "composer.continueLine": () => update(continued),
    "composer.navigate": (name) => {
      const step = direction(latest.current.keymap, "composer.navigate", name);
      if (step === 0) return false;
      const popup = popupNow();
      if (popup) return update((s) => moveHighlight(s, popup, step));
      const state = box.current;
      if (step === -1 && !onFirstLine(state.editor)) return update((s) => ({ ...s, editor: up(s.editor) }));
      if (step === 1 && !onLastLine(state.editor)) return update((s) => ({ ...s, editor: down(s.editor) }));
      return update((s) => walked(s, walkTexts(), step === -1 ? 1 : -1));
    },
    "composer.complete": () => {
      const state = box.current;
      if (state.search !== null) return void set(searchClosed(state, false));
      const popup = popupNow();
      if (popup?.kind === "commands") return void set(acceptCommand(state, popup));
      if (popup?.kind === "mentions") {
        const accepted = acceptMention(state, popup);
        if (accepted) {
          latest.current.picked(accepted.path);
          return void set(accepted.state);
        }
      }
      if (popup?.kind === "snippets") return void set(acceptSnippet(state, popup));
      // A popup with nothing to fill in leaves Tab to a snippet's stops, and with none of those to the focus.
      return update((s) => walkStops(s, 1));
    },
    "composer.slot.back": () => update((s) => walkStops(s, -1)),
    "composer.backspace": () => {
      const state = box.current;
      if (state.search !== null) {
        if (state.search.query.length === 0) return void set(searchClosed(state, true));
        return void set(searched(state, { query: [...state.search.query].slice(0, -1).join(""), at: 0 }, (s) => matchesOf(s.query, s.scope)));
      }
      return update(rubbedOut);
    },
    "composer.line.start": moved(lineStart),
    "composer.line.end": moved(lineEnd),
    "composer.buffer.start": moved(bufferStart),
    "composer.buffer.end": moved(bufferEnd),
    "composer.word.back": moved(wordLeft),
    "composer.word.forward": moved(wordRight),
    "composer.word.deleteBack": moved(deleteWordLeft),
    "composer.word.deleteForward": moved(deleteWordRight),
    "composer.cut.toStart": () => update((s) => ({ ...s, editor: killToLineStart(s.editor), stops: null })),
    "composer.cut.toEnd": moved(killToLineEnd),
    "composer.yank": moved(yank),
    "composer.undo": moved(undo),
    "composer.history.search": () => {
      const state = box.current;
      if (state.search === null) return update(searching);
      return update((s) => (s.search === null ? s : searched(s, { at: s.search.at + 1 }, (search) => matchesOf(search.query, search.scope))));
    },
    "composer.history.scopeOrStash": () => {
      const state = box.current;
      if (state.search !== null) {
        const scopes = Math.max(1, latest.current.scopes.length);
        return update((s) => (s.search === null ? s : searched(s, { scope: (s.search.scope + 1) % scopes, at: 0 }, (search) => matchesOf(search.query, search.scope))));
      }
      if (update(stashed) === false) return false;
      latest.current.say(box.current.stash === null ? "Given back what was set aside." : "Set aside; Ctrl+S gives it back.");
    },
    "composer.paste": () => {
      const { clipboard } = latest.current;
      void (async () => {
        const image = await clipboard.readImage().catch(() => null);
        if (image) {
          const attachment = (number: number): AttachmentInput | null => attachmentFromBytes(`clipboard-${number}.png`, image.mediaType, image.bytes);
          const check = attachment(box.current.numbered + 1);
          if (check === null) return latest.current.say("The image on the clipboard is over the 20 MiB an attachment may be.");
          return set(pastedImage(box.current, (number) => attachment(number) ?? check));
        }
        const text = await clipboard.readText().catch(() => null);
        if (text !== null && text.length > 0) return set(pasted(box.current, text));
        latest.current.say("The clipboard holds no image and no text.");
      })();
    },
    "composer.editor": () => {
      void latest.current.editText(expandedText(box.current)).then((edited) => {
        // The paste chips went out expanded and are text now; a pasted image stays attached while its marker is still there.
        if (edited !== undefined) set({ ...replaced(box.current, edited.replace(/\n+$/, "")), chips: box.current.chips.filter((chip) => chip.kind === "image") });
      });
    },
    "composer.command.menu": () => (box.current.editor.text.length === 0 ? update((s) => typed(s, "/")) : false),
  };

  const state = box.current;
  const popup = host.active ? popupOf(state, host.sources) : null;
  return {
    state,
    popup,
    text: expandedText(state),
    current: () => expandedText(box.current),
    handlers,
    type(text) {
      if (box.current.search !== null) {
        const clean = text.replace(/[\r\n]+/g, " ").replace(/\p{Cc}/gu, "");
        return void update((s) => (s.search === null ? s : searched(s, { query: s.search.query + clean, at: 0 }, (search) => matchesOf(search.query, search.scope))));
      }
      update((s) => typed(s, text));
    },
    paste(text) {
      update((s) => pasted(searchClosed(s, false), text));
    },
    edit(key) {
      if (box.current.search !== null) {
        if (key !== "right") return false;
        return update((s) => searchClosed(s, false)) !== false;
      }
      return update((s) => ({ ...s, editor: key === "left" ? left(s.editor) : key === "right" ? right(s.editor) : deleteForward(s.editor) })) !== false;
    },
    set,
    searching: state.search !== null,
    cancelSearch() {
      update((s) => searchClosed(s, true));
    },
    attach(attachment) {
      update((s) => ({ ...s, attached: [...s.attached, attachment] }));
    },
  };
};

/** The note under the box: where a history walk stands, the snippet stops left, what goes attached. */
export const composerNote = (state: ComposerState, completeKey: string): string | undefined => {
  const notes: string[] = [];
  const place = walkPlace(state);
  if (place !== null) notes.push(`history ${place.at} of ${place.of}`);
  const stops = liveStops(state);
  if (stops !== null) {
    const left = stops.slots.length - 1 - stops.at + (stops.final === undefined ? 0 : 1);
    notes.push(left === 0 ? `${completeKey} leaves the last slot` : `${completeKey} next slot · ${left} left`);
  }
  const attached = outgoing(state).attachments;
  if (attached.length > 0) notes.push(`attached: ${attached.map((a) => a.name).join(", ")}`);
  return notes.length > 0 ? notes.join(" · ") : undefined;
};

export { highlighted };
