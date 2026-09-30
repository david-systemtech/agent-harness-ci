import { randomUUID } from "node:crypto";
import { SESSION_STREAM_KIND, TRANSCRIPT_EVENT_TYPES, type SessionHistoryImportedPayload, type SessionOrigin } from "@agent-harness/contracts";
import { capability } from "../adapter/capabilities.js";
import type { HistoryEvent } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import type { EventInput, EventLog } from "../event-log/event-log.js";
import { readOrigin, readSummary, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { accountSource } from "./sessions.js";

/**
 * An imported session's history on first open (ADR 0021; #579): the first
 * `sessions.subscribeSession` of an imported session whose history is not in
 * the log yet has its adapter read the provider session's transcript, and
 * its subagent transcripts, from the account's directory (`readHistory`),
 * and appends it once, before the snapshot goes out; from then on every
 * client reads the log. The history's events carry one run id that no
 * `run.started` names, since no harness run made them, and the provider's
 * own times; its user messages are `message.sent`, read (`prompt`), with the
 * lowest ceiling, `plan`, since nobody sent them through the environment and
 * no run ever reads them. `session.history-imported` closes the append, in
 * its transaction, and is what later opens find. A transcript the directory
 * no longer holds, or a read that fails, is the same event with outcome
 * `unreadable` and why, which the transcript shows as one line; the session
 * opens without its history, and later opens do not read again. Opens that
 * come while a read is under way wait for that read; the transaction looks
 * again, so the history is appended once whatever the timing. Nothing in the
 * adopted directory is written: the adapter only reads it.
 */

/** Who appends an imported session's history. */
export const HISTORY_IMPORT_ACTOR = "system:carry-over";

/** The ceiling an imported user message is recorded with: the lowest, since nobody sent it through the environment. */
const IMPORTED_MESSAGE_CEILING = "plan";

export interface ImportedHistoryOptions {
  readonly log: EventLog;
  /** The accounts and their adapters: the host's. */
  readonly host: Pick<AdapterHost, "account" | "adapters">;
  /** Where a history event outside its schema, or a failed append, is told; preset: the console. */
  readonly diagnostic?: (message: string, detail?: unknown) => void;
}

export interface ImportedHistory {
  /**
   * What the session's open waits for: the append of its history, when it
   * is an imported session whose history is not in the log yet; null when
   * there is nothing to wait for, so an open that needs none keeps its
   * place among its socket's requests. Never rejects: a failed append is
   * told and the session opens as the log has it.
   */
  beforeOpen(sessionId: string): Promise<void> | null;
}

/** The history's events as the log records them, under `runId`: each checked against its schema, one outside it left out. */
const historyInputs = (history: readonly HistoryEvent[], runId: string, dropped: (event: HistoryEvent, issues: unknown) => void): EventInput[] =>
  history.flatMap((event): EventInput[] => {
    const payload =
      event.type === "message.sent"
        ? { ...event.payload, runId, messageId: randomUUID(), delivery: "prompt", heldBy: null, ceiling: IMPORTED_MESSAGE_CEILING }
        : { ...event.payload, runId };
    const checked = TRANSCRIPT_EVENT_TYPES[event.type].payload.safeParse(payload);
    if (!checked.success) {
      dropped(event, checked.error.issues);
      return [];
    }
    return [{ type: event.type, payload: checked.data as Record<string, unknown>, ...(event.at !== null && { occurredAt: event.at }) }];
  });

export const createImportedHistory = (options: ImportedHistoryOptions): ImportedHistory => {
  const { log, host } = options;
  const diagnostic = options.diagnostic ?? ((message, detail) => console.error(message, detail));
  // The log's query-only read: inside a transaction it reads that transaction's own writes.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** The reads under way, by session: a second open waits for the first's. */
  const pending = new Map<string, Promise<void>>();

  /** Whether the session's history is in the log: its `session.history-imported` is on its stream, whatever the outcome. */
  const imported = (sessionId: string): boolean =>
    reader.all(`SELECT 1 FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ? AND type = 'session.history-imported' LIMIT 1`, sessionId).length > 0;

  /** The history the adopted account's adapter reads, or why it could not be read. */
  const read = async (origin: SessionOrigin): Promise<{ readonly history: readonly HistoryEvent[] } | { readonly unreadable: string }> => {
    const source = accountSource(host, origin.accountId);
    if (source === null) return { unreadable: `The account ${origin.accountId} its history lives in is no longer on this environment.` };
    const where = source.account.directory ?? `the account ${origin.accountId}'s directory`;
    try {
      const readHistory = capability(source.adapter.descriptor, "sessionListing", source.adapter.readHistory, "read an imported session's history", "readHistory");
      const history = await readHistory.call(source.adapter, source.account, origin.providerSessionId);
      return history === null ? { unreadable: `No transcript of ${origin.providerSessionId} is in ${where} any more.` } : { history };
    } catch (error) {
      return { unreadable: `Reading ${origin.providerSessionId} from ${where} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const append = async (sessionId: string, origin: SessionOrigin): Promise<void> => {
    const found = await read(origin);
    const runId = randomUUID();
    const dropped = (event: HistoryEvent, issues: unknown) => diagnostic(`A ${event.type} of the imported session ${sessionId}'s history is outside its schema; it is left out.`, issues);
    const events = "history" in found ? historyInputs(found.history, runId, dropped) : [];
    const payload: SessionHistoryImportedPayload = {
      runId,
      providerSessionId: origin.providerSessionId,
      outcome: "history" in found ? "appended" : "unreadable",
      message: "unreadable" in found ? found.unreadable : null,
    };
    log.atomically((tx) => {
      // Appended meanwhile, or the session gone (deleted or purged) while it was read: nothing to add.
      if (imported(sessionId) || readSummary(reader, sessionId) === null) return;
      log.append(sessionStream(sessionId), [...events, { type: "session.history-imported", payload }], { tx, actor: HISTORY_IMPORT_ACTOR, correlationId: runId });
    });
  };

  return {
    beforeOpen(sessionId) {
      const id = sessionId.toLowerCase();
      const under = pending.get(id);
      if (under !== undefined) return under;
      const origin = readOrigin(reader, id);
      if (origin?.kind !== "import" || imported(id)) return null;
      const appending = append(id, origin)
        .catch((error: unknown) => diagnostic(`Appending the imported session ${id}'s history failed; it opens without it.`, error))
        .finally(() => pending.delete(id));
      pending.set(id, appending);
      return appending;
    },
  };
};
