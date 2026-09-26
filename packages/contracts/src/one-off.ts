/**
 * A one-off command's convention over a terminal (tui spec, "The composer":
 * `!!` runs a command in an environment-owned terminal and sends its output;
 * #148): what a client puts in `terminals.open`'s variables and types with
 * `terminals.write`, and how it reads what came back. The terminal UI runs
 * it (`packages/tui/src/terminal/one-off.ts`, where the design is told);
 * the environment's tests prove it against real pseudo-terminals, which is
 * why it lives here, where both may import it. Pure.
 */

/** The variable the command's script is handed in. */
export const ONE_OFF_VARIABLE = "AGENT_HARNESS_ONE_OFF";

/** The line typed into a one-off terminal: its shell hands itself over to `sh` running the script. The space keeps it out of history. */
export const ONE_OFF_LINE = ` exec /bin/sh -c "$${ONE_OFF_VARIABLE}"\r`;

/** Output held after the marker, in characters; past it the command runs on, unheard. */
export const ONE_OFF_MAX_CHARS = 256 * 1024;

/** What is held of the terminal before the marker: its tail, to say why when the marker never comes. */
const PREAMBLE_MAX_CHARS = 16 * 1024;

/** The pagers a `!!` command finds, each told to print: nobody is there to press a key. */
export const NO_PAGERS: Readonly<Record<string, string>> = { PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "cat" };

/** The script `sh` runs for `!!`: the marker, no input, no pager, then the command as typed. */
export const oneOffScript = (command: string, marker: string): string =>
  [
    `printf '%s\\n' '${marker}'`,
    "exec </dev/null",
    `${Object.entries(NO_PAGERS)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}; export ${Object.keys(NO_PAGERS).join(" ")}`,
    command,
  ].join("\n");

/** The variables a `!!` terminal opens with. */
export const oneOffEnv = (command: string, marker: string): Record<string, string> => ({ ...NO_PAGERS, [ONE_OFF_VARIABLE]: oneOffScript(command, marker) });

/** What a `!!` terminal printed, held as it arrives: the tail of what came before the marker's line, and up to `ONE_OFF_MAX_CHARS` after it. */
export interface OneOffOutput {
  take(data: string): void;
  /**
   * Starts again from `data` (a snapshot: the retained scrollback). One that no longer holds the marker's line, once it
   * had come, is all the command's, its start dropped.
   */
  reset(data: string): void;
  /** What came after the marker's line, whether more came than was held, and whether its start was dropped; null before the marker's line has come. */
  said(): { readonly text: string; readonly cut: boolean; readonly dropped: boolean } | null;
  /** The tail of what came before the marker (all of it, while no marker has come). */
  before(): string;
}

export const oneOffOutput = (marker: string, max = ONE_OFF_MAX_CHARS): OneOffOutput => {
  let before = "";
  let after: string | null = null;
  let cut = false;
  let dropped = false;
  const hold = (data: string) => {
    const room = max - (after ?? "").length;
    if (data.length > room) cut = true;
    after = (after ?? "") + data.slice(0, Math.max(0, room));
  };
  const take = (data: string) => {
    if (after !== null) return hold(data);
    before += data;
    const at = before.indexOf(marker);
    const end = at === -1 ? -1 : before.indexOf("\n", at);
    if (end === -1) {
      // The marker may be arriving in pieces: the tail kept is always longer than it.
      if (before.length > PREAMBLE_MAX_CHARS) before = before.slice(-PREAMBLE_MAX_CHARS);
      return;
    }
    const rest = before.slice(end + 1);
    before = before.slice(0, at);
    hold(rest);
  };
  return {
    take,
    reset(data) {
      const started = after !== null;
      before = "";
      after = null;
      cut = false;
      // The scrollback's cap took the marker's line after it had come: everything retained came after it.
      dropped = started && !data.includes(marker);
      if (dropped) after = "";
      take(data);
    },
    said: () => (after === null ? null : { text: after, cut, dropped }),
    before: () => before,
  };
};
