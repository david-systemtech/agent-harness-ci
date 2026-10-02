import { SESSION_STREAM_KIND, type SessionBankUsedPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { BANKS_ACTOR } from "./bank-service.js";

/** Session use is durable, survives queue consumption and is removed with the session's stream. */
export const recordBankUse = (log: EventLog, sessionId: string, bankId: string, pointers: readonly string[]): void => {
  const unique = [...new Set(pointers)];
  if (unique.length === 0) return;
  log.atomically((tx) => log.append({ kind: SESSION_STREAM_KIND, id: sessionId }, [{ type: "session.bank-used", payload: { bankId, pointers: unique } satisfies SessionBankUsedPayload }], { tx, actor: BANKS_ACTOR }));
};

/** Only live banks in the current scope may contribute a session's earlier use. */
export const recentBankUse = (log: EventLog, sessionId: string, bankIds: ReadonlySet<string>): string[] =>
  [...new Set(log.read<{ payload: string }>("SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'session.bank-used' ORDER BY sequence", SESSION_STREAM_KIND, sessionId)
    .flatMap(({ payload }) => {
      const used = JSON.parse(payload) as SessionBankUsedPayload;
      return bankIds.has(used.bankId) ? used.pointers : [];
    }))];

/** The first sent message is retained by transcript compaction; later messages never replace it. */
export const firstBankMessage = (log: EventLog, sessionId: string): string | null => {
  const [row] = log.read<{ text: string }>("SELECT json_extract(payload, '$.text') AS text FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'message.sent' ORDER BY sequence LIMIT 1", SESSION_STREAM_KIND, sessionId);
  return row?.text ?? null;
};
