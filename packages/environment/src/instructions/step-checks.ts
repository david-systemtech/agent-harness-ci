import { NO_ACCOUNT_ORIENTATION_LINE, unreadSetupLine, unreadSetupSteps } from "@agent-harness/contracts";
import type { DoneLine, StateCheckers } from "../setup/check.js";
import type { OrientationAnswer } from "./composer.js";

/**
 * The same local preview the Orientation row reads, regardless of its enabled switch (ADR 0030; #514): a section it could
 * not read names the Set up step where that part is set up, the sections themselves in details (setup-copy.md §5.10).
 */
export const instructionsStateChecks = (orientation: () => Promise<OrientationAnswer | null>): Pick<StateCheckers, "instructions.orientation-renders"> => ({
  "instructions.orientation-renders": async () => {
    const answer = await orientation();
    // With no account, no run can receive a block yet; the Account step owns that state, and the done line points to it.
    const unread = answer?.unreadRegistries ?? [];
    return unread.length === 0 || { reason: unreadSetupLine(unreadSetupSteps(unread)), details: [`Unread sections of the orientation block: ${unread.join(", ")}`] };
  },
});

/** The Instructions step's line when done with no account to tell agents about: sign in on the Account step first (setup-copy.md §5.10). */
export const instructionsDoneLine =
  (accounts: () => readonly unknown[]): DoneLine =>
  () =>
    accounts().length === 0 ? { reason: NO_ACCOUNT_ORIENTATION_LINE } : undefined;
