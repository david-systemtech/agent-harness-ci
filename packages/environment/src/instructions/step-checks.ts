import type { StateCheckers } from "../setup/check.js";
import type { OrientationAnswer } from "./composer.js";

/** The same local preview the Orientation row reads, regardless of its enabled switch (ADR 0030; #514). */
export const instructionsStateChecks = (orientation: () => Promise<OrientationAnswer | null>): Pick<StateCheckers, "instructions.orientation-renders"> => ({
  "instructions.orientation-renders": async () => {
    const answer = await orientation();
    // With no account, no run can receive a block yet; the Account step owns that state.
    const unread = answer?.unreadRegistries ?? [];
    return unread.length === 0 || { reason: `The orientation block could not read these registries: ${unread.join(", ")}.` };
  },
});
