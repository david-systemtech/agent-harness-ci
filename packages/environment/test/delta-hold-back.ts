import { DELTA_HOLD_BACK_MS } from "../src/adapter/delta-scrub.js";
import type { TestEnvironment } from "./helper.js";

/**
 * The environment holds back a streamed tail that could begin a registered value, until the item's next delta or its
 * settled text comes, the run ends, or `DELTA_HOLD_BACK_MS` on its clock has passed (`delta-scrub.ts`). A test
 * environment registers its own signing key, random base64, so in about one run in 64 a reply's last letter is held;
 * and its clock is manual, so a test that waits for a delta whole while the run is held open after it waits for ever
 * unless it moves that clock (#1133, #1139).
 */

/**
 * Registers on `t` a value beginning with the last character of `text`, a reply's streamed delta, so the environment
 * holds that character back in every run, as it does in one run in 64 for its signing key: the path `deltaShown`
 * must see through, taken every time.
 */
export const holdBackLastOf = (t: Pick<TestEnvironment, "scrub">, text: string): void => {
  t.scrub.register(`${text.slice(-1)}-held-back-by-the-test`, { owner: "test:hold-back" });
};

/**
 * Waits until `text`, a reply's streamed delta the run is held open after, shows whole, where `shows(prefix)` waits
 * until the reply shows `prefix` at its start, with the test's own polling. Once the reply has begun, the environment
 * has taken the delta and set the hold-back's timer for any tail it holds, so moving its clock past the hold-back
 * shows the rest.
 */
export const deltaShown = async (t: Pick<TestEnvironment, "clock">, text: string, shows: (prefix: string) => Promise<unknown>): Promise<void> => {
  await shows(text.slice(0, 1));
  t.clock.advance(DELTA_HOLD_BACK_MS);
  await shows(text);
};
