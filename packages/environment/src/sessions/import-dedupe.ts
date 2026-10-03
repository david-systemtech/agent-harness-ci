import type { SessionArchivedPayload, SessionDeletedPayload, SessionPinnedPayload } from "@agent-harness/contracts";
import type { AppendOptions, EventLog, Tx } from "../event-log/event-log.js";
import type { Deletion } from "./deletion.js";
import type { SessionRow } from "./session-tables.js";
import { sessionStream } from "./streams.js";

/** Repair only imported rows whose source has proved they are the same transcript.
 * Keep a continued row's history before preferring the source owner, and union pins and archive state.
 * Purging a redundant row never asks to delete its provider transcript.
 */
export const reconcileImportedSessions = (log: EventLog, deletion: Deletion) => (
  accountIds: readonly string[], providerSessionId: string, ownerAccountId: string,
  attribution: AppendOptions & { readonly tx: Tx },
): string | undefined => {
  const rows = log.read<SessionRow & { runs: number; sourceAccountId: string }>(
    "SELECT sessions.*, json_extract(origin, '$.accountId') AS sourceAccountId, (SELECT count(*) FROM runs WHERE runs.session_id = sessions.id) AS runs FROM sessions WHERE json_extract(origin, '$.kind') = 'import' AND json_extract(origin, '$.providerSessionId') = ? ORDER BY created_at, id",
    providerSessionId,
  ).filter((row) => accountIds.includes(row.sourceAccountId));
  rows.sort((a, b) => b.runs - a.runs || Number(b.sourceAccountId === ownerAccountId) - Number(a.sourceAccountId === ownerAccountId));
  const winner = rows[0];
  if (winner === undefined) return undefined;
  // Two independently continued conversations are no longer redundant history. Retain both for manual repair.
  if (rows.slice(1).some((row) => row.runs > 0 || row.live_run_id !== null)) throw new Error("Shared imported sessions have independently continued history; automatic removal is refused.");
  for (const duplicate of rows.slice(1)) {
    if (winner.pinned_at === null && duplicate.pinned_at !== null) {
      const payload: SessionPinnedPayload = { pinnedAt: duplicate.pinned_at, pinOrderKey: duplicate.pin_order_key };
      log.append(sessionStream(winner.id), [{ type: "session.pinned", payload }], attribution);
      winner.pinned_at = duplicate.pinned_at;
    }
    if (winner.archived_at === null && duplicate.archived_at !== null) {
      const payload: SessionArchivedPayload = { archivedAt: duplicate.archived_at };
      log.append(sessionStream(winner.id), [{ type: "session.archived", payload }], attribution);
      winner.archived_at = duplicate.archived_at;
    }
    const at = new Date().toISOString();
    const payload: SessionDeletedPayload = { deletedAt: at, purgeAt: at, deleteProviderTranscript: false };
    log.append(sessionStream(duplicate.id), [{ type: "session.deleted", payload }], attribution);
    deletion.purgeSession(duplicate.id, attribution);
  }
  return winner.id;
};
