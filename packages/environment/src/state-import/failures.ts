import type { StateImportFailure } from "@agent-harness/contracts";

/**
 * What an item's preparation or application throws when it can name its
 * failure in full (setup-copy.md §5.3): the plain line, the step whose card
 * fixes it, and the facts for Details. The item protocol reports it under
 * the item's label in place of the thrown message.
 */
export class ItemFailure extends Error {
  constructor(readonly failure: Omit<StateImportFailure, "label">) {
    super(failure.message);
    this.name = "ItemFailure";
  }
}

/** A source store that could not be read: one plain line, with the store's own diagnostic under Details. */
export const unreadStore = (label: string, diagnostic: string): StateImportFailure => ({
  label,
  message: "agent-harness could not read this part of your earlier work.",
  details: [diagnostic],
});
