import type { QueuedMessage, TranscriptRow } from "@agent-harness/client-runtime";

/** What the transcript draws, in order: its rows, and the session's queued messages among them. */
export type Drawn = { readonly kind: "row"; readonly row: TranscriptRow } | { readonly kind: "queued"; readonly message: QueuedMessage };

/**
 * The transcript's rows with each queued message drawn after its turn
 * (docs/specs/gui.md, "A session pane"): after the last row of the run it was
 * sent during, that run's turn row included once it ends, in the order sent.
 * A message whose run has drawn nothing yet goes at the end. Its place comes
 * from the run it was sent during and the order it was sent in, so a message
 * an interrupt re-owned (`message.requeued`, a change of holder alone) keeps
 * its place.
 */
export const withQueued = (rows: readonly TranscriptRow[], queue: readonly QueuedMessage[]): readonly Drawn[] => {
  const lastOf = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.runId !== null) lastOf.set(row.runId, index);
  });
  const after = new Map<number, QueuedMessage[]>();
  const atEnd: QueuedMessage[] = [];
  for (const message of queue) {
    const at = lastOf.get(message.runId);
    if (at === undefined) atEnd.push(message);
    else after.set(at, [...(after.get(at) ?? []), message]);
  }
  const queued = (message: QueuedMessage): Drawn => ({ kind: "queued", message });
  return [...rows.flatMap((row, index): Drawn[] => [{ kind: "row", row }, ...(after.get(index) ?? []).map(queued)]), ...atEnd.map(queued)];
};
