import type { LadderName } from "@agent-harness/theme";

/**
 * The terminal's ground, light or dark (David, 2026-09-28, on #392): a
 * terminal cannot be told its theme, but it can be asked its background
 * colour, the standard query OSC 11. At launch, under truecolour, the
 * terminal UI writes it and then the primary device attributes query
 * (DA1), which every terminal answers, in the order asked: so DA1's answer
 * coming without a colour before it says the terminal has none to give,
 * and the wait ends there rather than on a timer. A ground is light when
 * dark text reads better on it than light text does (WCAG 2 contrast
 * against black over against white); with no answer it is dark.
 */

/** OSC 11 asking the background colour, ended by ST; then DA1. */
const BACKGROUND_QUERY = "\u001B]11;?\u001B\\";
const ATTRIBUTES_QUERY = "\u001B[c";

/** OSC 11's answer: `rgb:` (or `rgba:`) and each component in one to four hex digits, ended by BEL or ST. */
// eslint-disable-next-line no-control-regex -- the escapes are what is being read.
const BACKGROUND_ANSWER = /\u001B\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\u0007|\u001B\\)/i;
/** DA1's answer: `CSI ? … c`. */
// eslint-disable-next-line no-control-regex -- the escapes are what is being read.
const ATTRIBUTES_ANSWER = /\u001B\[\?[\d;]*c/;

/** How long the terminal UI waits for a terminal that answers neither query, in milliseconds. */
export const GROUND_WAIT_MS = 1000;

/** A component's hex digits as a fraction of their scale (`f` and `ffff` are both 1), then linear light. */
const linear = (digits: string): number => {
  const value = parseInt(digits, 16) / (16 ** digits.length - 1);
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** The ground the terminal's answer names; undefined when it names no background colour. */
export const groundOf = (answer: string): LadderName | undefined => {
  const found = BACKGROUND_ANSWER.exec(answer);
  if (found === null) return undefined;
  const [red, green, blue] = found.slice(1, 4).map((digits) => linear(digits ?? "0")) as [number, number, number];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  // Contrast with black, (L + 0.05) / 0.05, over contrast with white, 1.05 / (L + 0.05).
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "light" : "dark";
};

export interface GroundTerminal {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  /** Runs `callback` after `ms`, answering how to cancel it; preset the system's timer. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
}

const systemTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * Asks the terminal its background colour before the screen reads its
 * keys, and answers the ground it names: undefined when it gave none, or
 * when its input cannot be put in raw mode, in which case nothing is
 * written. The input is in raw mode while asked and goes back as it was;
 * keys typed after the answers are handed back to it for the screen.
 */
export const askGround = (terminal: GroundTerminal): Promise<LadderName | undefined> => {
  const { stdin, stdout } = terminal;
  if (typeof stdin.setRawMode !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    let heard = "";
    const finish = () => {
      cancel();
      stdin.off("readable", read);
      const ground = groundOf(heard);
      const after = ATTRIBUTES_ANSWER.exec(heard);
      const rest = after === null ? "" : heard.slice(after.index + after[0].length);
      if (rest.length > 0) stdin.unshift(Buffer.from(rest, "utf8"));
      stdin.setRawMode(wasRaw);
      resolve(ground);
    };
    const read = () => {
      let chunk: unknown;
      while ((chunk = stdin.read()) !== null) heard += String(chunk);
      if (ATTRIBUTES_ANSWER.test(heard)) finish();
    };
    stdin.setRawMode(true);
    stdin.on("readable", read);
    const cancel = (terminal.setTimer ?? systemTimer)(finish, GROUND_WAIT_MS);
    stdout.write(`${BACKGROUND_QUERY}${ATTRIBUTES_QUERY}`);
  });
};
