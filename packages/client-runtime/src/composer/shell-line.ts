/**
 * A shell line typed into the composer (docs/specs/tui.md, "The composer";
 * docs/specs/gui.md, "A session pane", `!` and `!!` as in the terminal UI):
 * `!` and a command runs it in a terminal of its own in the session's
 * terminal pane; `!!` and a command runs it and sends what it printed to the
 * agent. The command is the rest of the text, trimmed; null for text that is
 * no shell line.
 */
export const shellLine = (typed: string): { readonly send: boolean; readonly command: string } | null => {
  const text = typed.trim();
  if (!text.startsWith("!")) return null;
  const send = text.startsWith("!!");
  return { send, command: text.slice(send ? 2 : 1).trim() };
};
