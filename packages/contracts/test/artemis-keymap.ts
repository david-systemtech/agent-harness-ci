/**
 * Artemis's terminal keymap and slash commands at 443cf2e, as data: every row
 * of `KEYMAP`'s groups in `apps/tui/src/keymap.ts` but the slash group (which
 * Artemis builds from `COMMANDS`), and every entry of `COMMANDS` in
 * `apps/tui/src/commands.ts`, in their order, the text exactly as Artemis
 * wrote it. The shared action list is tested against this (ADR 0004, the tui
 * spec's "Shortcuts"); it is a transcription and is never re-derived. At
 * 443cf2e no row is `planned`.
 */

/** A row of one of `KEYMAP`'s groups: its keys, alternatives, and what it does. */
export interface ArtemisKeyRow {
  readonly keys: readonly string[];
  readonly does: string;
}

/** One of `KEYMAP`'s groups: its title, its context and its rows. */
export interface ArtemisKeyGroup {
  readonly title: string;
  readonly context: string;
  readonly rows: readonly ArtemisKeyRow[];
}

/** An entry of `COMMANDS`. */
export interface ArtemisCommand {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
}

export const ARTEMIS_COMMIT = "443cf2e";

export const ARTEMIS_KEYMAP: readonly ArtemisKeyGroup[] = [
  {
    title: "Anywhere",
    context: "anywhere",
    rows: [
      { keys: ["Tab"], does: "Round the composer, the list, the strip and the rows" },
      { keys: ["Shift+Tab"], does: "Step the permission mode on" },
      { keys: ["Esc"], does: "Interrupt; or follow the end again" },
      { keys: ["Esc Esc"], does: "Go back to an earlier prompt" },
      { keys: ["Ctrl+C"], does: "Interrupt; again in a moment to quit" },
      { keys: ["Ctrl+O"], does: "Unfold the whole transcript" },
      { keys: ["Ctrl+T"], does: "Show or hide the checklist" },
      { keys: ["Ctrl+]"], does: "Go to the next conversation that needs you" },
      { keys: ["Alt+H"], does: "Hand this conversation to another account" },
      { keys: ["?"], does: "Open this map, from an empty composer" },
    ],
  },
  {
    title: "Writing a message",
    context: "composer",
    rows: [
      { keys: ["Enter"], does: "Send it, steer a turn, run a row, send a failed check" },
      { keys: ["Shift+Enter", "Ctrl+J"], does: "A newline instead of sending" },
      { keys: ["\\ Enter"], does: "A backslash keeps the line open" },
      { keys: ["↑", "↓"], does: "The text, then the queue, then history" },
      { keys: ["/"], does: "Start a command, and see the menu" },
      { keys: ["@"], does: "Name a file, and see the paths" },
      { keys: [";;"], does: "Expand a saved snippet; Tab walks its slots" },
      { keys: ["Tab"], does: "Fill in the highlighted row, or the next slot" },
      { keys: ["Shift+Tab"], does: "Back to the slot before, in a snippet" },
      { keys: ["!"], does: "Run a shell command; !! sends the output" },
      { keys: ["Ctrl+V"], does: "Paste an image, or the text there" },
      { keys: ["Ctrl+G"], does: "Edit the draft in $EDITOR" },
      { keys: ["1–4"], does: "Take one of the follow-ups the agent offered" },
    ],
  },
  {
    title: "Moving and editing",
    context: "composer",
    rows: [
      { keys: ["Ctrl+A", "Home"], does: "The start of the line" },
      { keys: ["Ctrl+E", "End"], does: "The end of it" },
      { keys: ["Ctrl+Home"], does: "The start of everything typed" },
      { keys: ["Ctrl+End"], does: "The end of everything typed" },
      { keys: ["Alt+B", "Ctrl+←"], does: "A word back" },
      { keys: ["Alt+F", "Ctrl+→"], does: "A word on" },
      { keys: ["Ctrl+W"], does: "Rub out the word before the cursor" },
      { keys: ["Alt+D"], does: "Delete the word after it" },
      { keys: ["Ctrl+U"], does: "Cut back to the start of the line" },
      { keys: ["Ctrl+K"], does: "Cut on to the end of it" },
      { keys: ["Ctrl+Y"], does: "Put back the last thing cut" },
      { keys: ["Ctrl+_"], does: "Undo" },
      { keys: ["Backspace"], does: "A whole paste chip; or the search query" },
    ],
  },
  {
    title: "What you typed before",
    context: "composer",
    rows: [
      { keys: ["Ctrl+R"], does: "Search back through past prompts" },
      { keys: ["Ctrl+S"], does: "What the search looks at; outside one, stash the draft" },
    ],
  },
  {
    title: "The conversation",
    context: "transcript",
    rows: [
      { keys: ["PgUp", "Shift+↑", "Ctrl+↑"], does: "Half a screen back" },
      { keys: ["PgDn", "Shift+↓", "Ctrl+↓"], does: "Half a screen on" },
      { keys: ["↑", "↓"], does: "The cursor’s row here; a line, from the box" },
      { keys: ["End"], does: "Back to the end, and follow it" },
    ],
  },
  {
    title: "A row of the conversation",
    context: "transcript",
    rows: [
      { keys: ["o"], does: "Open the file it touched, at the line" },
      { keys: ["r"], does: "Put the command it ran back in the composer" },
      { keys: ["y"], does: "Copy the row — a diff as a diff" },
      { keys: ["d"], does: "The whole diff it wrote" },
      { keys: ["Enter"], does: "Unfold what the row is holding back" },
      { keys: ["x"], does: "Stop the call that is still running" },
      { keys: ["Esc"], does: "Put the cursor away, back to the composer" },
    ],
  },
  {
    title: "The conversation list",
    context: "sidebar",
    rows: [
      { keys: ["↑", "↓"], does: "Move the cursor" },
      { keys: ["k", "j"], does: "The same — until a filter is being typed" },
      { keys: ["Enter"], does: "Open it, or fold the folder" },
      { keys: ["/"], does: "Filter the list by what you type" },
      { keys: ["Backspace"], does: "Rub a letter off the filter" },
      { keys: ["Space"], does: "Show what a conversation is, unopened" },
      { keys: ["a"], does: "Archive the one under the cursor" },
      { keys: ["d"], does: "Delete it" },
      { keys: ["p"], does: "Pin it to the top of its folder" },
      { keys: ["Ctrl+A"], does: "Archive it, while a filter is being typed" },
      { keys: ["Ctrl+D"], does: "Delete it, while filtering" },
      { keys: ["Ctrl+P"], does: "Pin it, while filtering" },
      { keys: ["Esc"], does: "Clear the filter; then back to the composer" },
    ],
  },
  {
    title: "Delegated work",
    context: "delegated",
    rows: [
      { keys: ["Tab"], does: "Reached after the list, while work is running" },
      { keys: ["↑", "↓"], does: "Move down the strip" },
      { keys: ["Enter"], does: "Open what that agent did" },
      { keys: ["x"], does: "Stop the task under the cursor" },
      { keys: ["→"], does: "Unfold a workflow's agents" },
      { keys: ["←"], does: "Fold them again" },
      { keys: ["Esc"], does: "Back to the composer" },
    ],
  },
  {
    title: "A list to choose from",
    context: "picker",
    rows: [
      { keys: ["↑", "↓"], does: "Move the cursor" },
      { keys: ["k", "j"], does: "The same, in a list that is not typed at" },
      { keys: ["Letters"], does: "Type to filter a long list" },
      { keys: ["Enter"], does: "Choose the row under the cursor" },
      { keys: ["Space"], does: "Preview it without opening it" },
      { keys: ["Ctrl+R"], does: "Rename the conversation under the cursor" },
      { keys: ["Ctrl+A"], does: "Archive it" },
      { keys: ["Ctrl+P"], does: "Pin it" },
      { keys: ["Esc"], does: "Clear the query; then close the list" },
    ],
  },
  {
    title: "A permission card",
    context: "permission",
    rows: [
      { keys: ["↑", "↓", "k", "j"], does: "Move down the answers" },
      { keys: ["Enter"], does: "Choose the one under the cursor" },
      { keys: ["Esc"], does: "Deny it; on a question, skip it" },
      { keys: ["Tab"], does: "A line: why, or what to do after" },
      { keys: ["e"], does: "Edit the rule that row would save" },
      { keys: ["s"], does: "Walk the scope it is saved at" },
      { keys: ["Space"], does: "Tick one of several options" },
    ],
  },
  {
    title: "The whole transcript",
    context: "pager",
    rows: [
      { keys: ["j", "k", "↑", "↓"], does: "A line" },
      { keys: ["Space"], does: "A screen on" },
      { keys: ["b"], does: "A screen back" },
      { keys: ["PgDn", "Ctrl+D"], does: "Half a screen on" },
      { keys: ["PgUp", "Ctrl+U"], does: "Half a screen back" },
      { keys: ["g", "Home"], does: "The top" },
      { keys: ["G", "End"], does: "The bottom" },
      { keys: ["}"], does: "The next turn" },
      { keys: ["{"], does: "The turn before" },
      { keys: ["/"], does: "Search the whole conversation" },
      { keys: ["n", "N"], does: "The next match, the one before" },
      { keys: ["v"], does: "Open the conversation in your editor" },
      { keys: ["q", "Esc"], does: "Close it" },
    ],
  },
];

export const ARTEMIS_COMMANDS: readonly ArtemisCommand[] = [
  { name: "profile", usage: "/profile", summary: "Switch the account the next conversation runs as" },
  { name: "model", usage: "/model", summary: "Choose the model, and its effort where it has one" },
  { name: "mode", usage: "/mode", summary: "Set the permission mode for the next turn" },
  { name: "resume", usage: "/resume", summary: "Pick up a stored conversation from this directory" },
  { name: "attach", usage: "/attach <path>", summary: "Send an image or file with the next message" },
  { name: "copy", usage: "/copy", summary: "Copy the last reply, or one of its code blocks, to the clipboard" },
  { name: "export", usage: "/export [file]", summary: "Write this conversation to a markdown file" },
  { name: "diff", usage: "/diff", summary: "What this conversation changed, and the working tree's diff" },
  { name: "undo", usage: "/undo", summary: "Take back the last file change the agent made" },
  { name: "check", usage: "/check [command|off|now]", summary: "Run this project's own lint or tests after the agent edits" },
  { name: "pin", usage: "/pin", summary: "Keep this conversation at the top of its folder" },
  { name: "title", usage: "/title <name>", summary: "Name this conversation" },
  { name: "asks", usage: "/asks", summary: "Every conversation waiting on a permission, answerable in one list" },
  { name: "timeline", usage: "/timeline", summary: "One line per turn: when, what, how long, what it cost, what it touched" },
  { name: "snip", usage: "/snip [name] [words]", summary: "Expand a saved snippet, or list them; save, rm and --examples keep them" },
  { name: "tasks", usage: "/tasks", summary: "Background work: what is running, and what a delegated agent did" },
  { name: "usage", usage: "/usage", summary: "The account's plan windows and how full they are" },
  { name: "handoff", usage: "/handoff", summary: "Move this conversation to another account, or start it fresh there" },
  { name: "cwd", usage: "/cwd", summary: "Choose where to work: a folder you have used, or browse for one" },
  { name: "new", usage: "/new", summary: "Start a fresh conversation on the same account" },
  { name: "help", usage: "/help", summary: "List these commands" },
  { name: "quit", usage: "/quit", summary: "Leave" },
];
