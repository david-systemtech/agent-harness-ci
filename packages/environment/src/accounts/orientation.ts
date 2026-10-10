import type { AccountStatusState } from "@agent-harness/contracts";
import { utcMinute, type OrientationSection } from "../instructions/orientation.js";
import type { AccountStanding } from "./account-store.js";

/**
 * The orientation block's accounts section (David's decision on #381,
 * 2026-09-28; the claude-adapter spec's account status in the orientation
 * block; ADR 0011, ADR 0018): one line per account the environment holds,
 * which a run's session could be handed to, with its label, whether it is
 * signed in and since when its status has stood, so a run knows when a
 * hand-off to another account would not work. The run's own account is
 * marked. Every line renders from the account store's read model, never a
 * clock and never the time of the latest status read, so a read that finds
 * nothing new leaves the text byte-identical.
 */

export interface AccountsSectionOptions {
  /** The accounts the environment holds, with since when each one's status has stood (`listAccountStandings`). */
  readonly accounts: () => readonly AccountStanding[];
}

/** Each status as an account's line states it. */
const STATE_WORDS: Readonly<Record<AccountStatusState, string>> = {
  "signed-in": "signed in",
  "signed-out": "signed out",
  expired: "expired",
  unreadable: "its status unreadable",
  unavailable: "temporarily unavailable; status will be checked again",
};

/** The list's heading: what the lines are for. */
const HEADING = "Accounts on this environment; a session can be handed to another only while it is signed in:";

/** The accounts section's provider, over the accounts as the store holds them now, for the account the run goes through. */
export const accountsSection = (options: AccountsSectionOptions): OrientationSection => ({
  name: "accounts",
  title: "Accounts",
  render: ({ accountId }) => [
    {
      heading: HEADING,
      items: options
        .accounts()
        .map(({ record, since }) => `${record.label}${record.id === accountId ? ", this run's" : ""}: ${STATE_WORDS[record.status.state]} since ${utcMinute(since)}.`),
    },
  ],
});
