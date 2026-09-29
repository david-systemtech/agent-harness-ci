/**
 * Keys on their way to a terminal (docs/specs/tui.md, "The terminal pane";
 * docs/specs/gui.md, "The seven panes and the grid"): a renderer gathers
 * what is typed and sends it through `terminals.write`, which carries at
 * most 1 MiB of text a command, so a paste larger than that goes in pieces.
 */

/** The most `terminals.write` carries in one command, in UTF-16 code units. */
export const TERMINAL_WRITE_CAP = 1024 * 1024;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * What of `outgoing` the next `terminals.write` carries: all of it up to the cap, and never one half of a character of
 * two code units, which would reach the shell as U+FFFD.
 */
export const nextWrite = (outgoing: string): string => {
  const high = outgoing.length > TERMINAL_WRITE_CAP && isHighSurrogate(outgoing.charCodeAt(TERMINAL_WRITE_CAP - 1));
  return outgoing.slice(0, high ? TERMINAL_WRITE_CAP - 1 : TERMINAL_WRITE_CAP);
};
