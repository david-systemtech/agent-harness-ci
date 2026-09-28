/**
 * The GUI map the surfaces port audit pins, as data: the reference desktop
 * renderer's keys at the commit the audit read (443cf2e), transcribed from
 * the code and never re-derived. Five places answer keys there: the
 * window's hotkey map (`App.tsx`), the composer's own handlers
 * (`Composer.tsx`), the permission, question and plan cards
 * (`InlinePermission.tsx`, `InlineQuestion.tsx`, `InlinePlan.tsx`), the find
 * bar (`FindInSession.tsx`) and the command palette (`CommandPalette.tsx`,
 * over cmdk in a dialog). The GUI column is tested against it (the GUI spec's
 * "Keyboard: the GUI column"; #388).
 *
 * Keys are written as the action list writes them: the renderer's `mod` is
 * `Mod` (⌘ on macOS, Ctrl elsewhere), `escape` is `Esc`, and a letter is a
 * capital. The words are the renderer's own: its empty-state legend where it
 * lists the key, else the label, tooltip or comment the key is drawn with.
 * `where` holds a row the renderer answers only in part of its place, in
 * the renderer's terms.
 *
 * Left out, as not keys of these five places: the composer's Esc, which
 * repeats the window's (the renderer says the two must agree); the slash
 * menu's own ↑, ↓ and Esc while it is open; the renderer's second spelling
 * of Mod+Shift+\ (`mod+shift+|`, what the key produces with Shift), one
 * chord; and the letters inside the sidebar's context menu, a menu's own
 * typeahead, which the GUI spec leaves to the context menu.
 */

/** A key the reference GUI answers: its keys, alternatives, where it is answered when only in part of its place, and what it does. */
export interface ReferenceGuiKeyRow {
  readonly keys: readonly string[];
  readonly where?: string;
  readonly does: string;
}

/** One of the five places the reference GUI answers keys, the action list's context for it, and its rows. */
export interface ReferenceGuiKeyGroup {
  readonly title: string;
  readonly context: string;
  readonly rows: readonly ReferenceGuiKeyRow[];
}

export const REFERENCE_GUI_KEYMAP: readonly ReferenceGuiKeyGroup[] = [
  {
    title: "The window",
    context: "anywhere",
    rows: [
      { keys: ["Mod+K"], does: "commands, sessions, settings" },
      { keys: ["Esc"], does: "stop the run, or deny a prompt" },
      { keys: ["Mod+F"], does: "Find in conversation" },
      { keys: ["Mod+N"], does: "new session" },
      { keys: ["Mod+B"], does: "show or hide the sidebar" },
      { keys: ["Mod+J"], does: "Open in the dock: Terminal" },
      { keys: ["Mod+Shift+B"], does: "Open in the dock: Browser" },
      { keys: ["Mod+\\"], does: "Split this conversation: Split right" },
      { keys: ["Mod+Shift+\\"], does: "Split this conversation: Split down" },
      { keys: ["Mod+,"], does: "settings" },
      { keys: ["Mod+I"], does: "run details" },
    ],
  },
  {
    title: "The composer",
    context: "composer",
    rows: [
      { keys: ["Enter"], does: "send the prompt" },
      { keys: ["Shift+Enter"], does: "new line" },
      {
        keys: ["↑", "↓"],
        where: "with the caret at the start of the field, Up while it is empty or holds a recalled prompt, Down while it holds one",
        does: "Up on an empty composer recalls the previous prompt, and keeps walking back; Down walks forward and off the end back to empty",
      },
      { keys: ["Tab"], does: "Tab accepts the highlighted command wherever the token is, and the suggested reply from an empty field" },
      { keys: ["/"], does: "A slash that starts a word opens the slash command menu" },
      { keys: ["Mod+V"], does: "Images attach by paste: a screenshot goes to the clipboard, and the gesture after taking one is Cmd+V" },
    ],
  },
  {
    title: "A permission, question or plan card",
    context: "permission",
    rows: [
      { keys: ["Mod+Enter"], does: "A modifier is required for approval: a bare Enter is far too easy to hit on reflex" },
      { keys: ["Esc"], does: "Deny" },
    ],
  },
  {
    title: "The find bar",
    context: "transcript",
    rows: [
      { keys: ["Enter"], where: "in the find bar's field", does: "Next match" },
      { keys: ["Shift+Enter"], where: "in the find bar's field", does: "Previous match" },
      { keys: ["Esc"], where: "in the find bar's field", does: "Close" },
    ],
  },
  {
    title: "The command palette",
    context: "picker",
    rows: [
      { keys: ["↑", "↓"], does: "Move through the list (cmdk)" },
      { keys: ["Enter"], does: "Run the highlighted entry (cmdk)" },
      { keys: ["Esc"], does: "Close the palette (its dialog)" },
      { keys: ["Backspace"], where: "at an empty query, on a sub-page", does: "Backspace at an empty query walks back out of a sub-page" },
    ],
  },
];
