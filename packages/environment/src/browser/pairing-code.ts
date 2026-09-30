import { randomInt } from "node:crypto";
import {
  CHROME_PAIRING_CODE_LENGTH,
  CHROME_PAIRING_GUESSES,
  CHROME_PAIRING_TTL_MS,
  PAIRING_CODE_ALPHABET,
  normaliseChromePairingCode,
} from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";

/**
 * The Chrome pairing code (browser spec, "The extension, its folder and its
 * listener"; ADR 0024; #548): one live code per environment, minted by
 * `browser.pairing.code` when none is live, eight characters of the pairing
 * alphabet, good for five minutes and one pairing, and void after five
 * wrong guesses. It lives in memory alone, never in the log: a restart
 * voids it, and the next `browser.pairing.code` mints another.
 */

/** The live code, as `browser.pairing.code` answers it. */
export interface LiveCode {
  readonly code: string;
  readonly expiresAt: string;
}

/** A code as typed was taken, or why not, as a sentence the extension shows. */
export type Taking = { readonly ok: true; readonly give: () => void } | { readonly ok: false; readonly reason: string };

export interface PairingCodes {
  /** The live code, minted now when none is live. */
  live(): LiveCode;
  /**
   * Takes `typed` for a pairing: the live code, read in its canonical form,
   * is spent (`give` puts it back when the pairing then fails), and any
   * other is refused with the sentence, a wrong guess at the live code
   * counting towards its five.
   */
  take(typed: string): Taking;
}

/** What became of the latest code minted. */
interface Minted {
  readonly code: string;
  readonly expiresAt: number;
  wrongGuesses: number;
  spent: boolean;
}

const mint = (): string =>
  Array.from({ length: CHROME_PAIRING_CODE_LENGTH }, () => PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length))).join("");

const SHOW_ANOTHER = "Open the Browser step in agent-harness for a new code, and type that one.";

export const createPairingCodes = (clock: Clock): PairingCodes => {
  let latest: Minted | undefined;

  const expired = (minted: Minted): boolean => clock.now().getTime() >= minted.expiresAt;
  const voided = (minted: Minted): boolean => minted.wrongGuesses >= CHROME_PAIRING_GUESSES;
  /** The latest code, while it is live. */
  const liveCode = (): Minted | undefined => (latest !== undefined && !latest.spent && !voided(latest) && !expired(latest) ? latest : undefined);

  return {
    live() {
      const minted = liveCode() ?? (latest = { code: mint(), expiresAt: clock.now().getTime() + CHROME_PAIRING_TTL_MS, wrongGuesses: 0, spent: false });
      return { code: minted.code, expiresAt: new Date(minted.expiresAt).toISOString() };
    },

    take(typed) {
      const code = normaliseChromePairingCode(typed);
      const minted = latest;
      if (minted !== undefined && code === minted.code) {
        if (minted.spent) return { ok: false, reason: `That code has been used already: a code pairs one Chrome. ${SHOW_ANOTHER}` };
        if (voided(minted)) return { ok: false, reason: `That code is void after five wrong codes were typed. ${SHOW_ANOTHER}` };
        if (expired(minted)) return { ok: false, reason: `That code has expired: a code is good for five minutes. ${SHOW_ANOTHER}` };
        minted.spent = true;
        return { ok: true, give: () => void (minted.spent = false) };
      }
      const live = liveCode();
      if (live === undefined) {
        if (minted !== undefined && voided(minted) && !expired(minted)) return { ok: false, reason: `The code is void after five wrong codes were typed. ${SHOW_ANOTHER}` };
        return { ok: false, reason: `No pairing code is live on this environment. ${SHOW_ANOTHER}` };
      }
      live.wrongGuesses += 1;
      if (voided(live)) return { ok: false, reason: `That is not the code agent-harness shows, and after five wrong codes the code is void. ${SHOW_ANOTHER}` };
      return { ok: false, reason: "That is not the code agent-harness shows. Check it and type it again." };
    },
  };
};
