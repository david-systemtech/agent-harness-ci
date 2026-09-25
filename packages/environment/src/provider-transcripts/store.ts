import { foldSessionSummary, type SessionKey, type SessionStore, type SessionStoreEntry, type SessionSummaryEntry } from "@anthropic-ai/claude-agent-sdk";
import type { EventLog, Tx } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { StoredSummary, TranscriptKey } from "./table.js";

/**
 * The environment's SDK session store (claude-adapter spec, "The SDK session
 * store and auto memory"; ADR 0018): the Agent SDK's `SessionStore` over the
 * provider transcripts' tables beside the log (`table.ts`, migration 6). The
 * entries are opaque provider state, so they are not events: the SDK
 * mirrors every transcript line here as the CLI writes it, and loads a
 * session back from here to resume it on any account, whose process then
 * runs in a temporary directory the SDK deletes; from a session's second
 * run the store is the durable copy.
 *
 * Keys are the SDK's: a Claude run names its project directory after the
 * harness session (`CLAUDE_CODE_PROJECT_DIR_NAME`), which the SDK takes as
 * the project key, so everything a session's runs wrote is under its id and
 * the purge removes it by that id (`purgeSession`, inside the purge's
 * transaction). A fork copies the source's rows under the fork's id when it
 * is created (`copySession`), so each session owns its conversation and a
 * purge of one never takes the other's.
 *
 * `append` folds the session's summary with the SDK's own
 * `foldSessionSummary`, and serialises the read-fold-write per session by
 * doing all of it synchronously inside one transaction of the log's single
 * connection: no two appends can interleave, whatever the SDK calls
 * together. An entry's `uuid` is its idempotency key (a retried batch is not
 * stored twice); one without is appended as it comes. Beside the SDK's
 * summary it keeps the same fold over every entry but a user's rename, which
 * the Claude adapter lists to read the provider's own title, so a title the
 * harness mirrored in is never read back as the provider's (`listUnrenamedSummaries`).
 */

/** The entry type the SDK's `renameSession` appends (0.3.281's source; `store.test.ts` holds it to the real helper). */
export const RENAME_ENTRY_TYPE = "custom-title";

export interface ProviderTranscriptStore extends Required<SessionStore> {
  /**
   * The summaries as `listSessionSummaries` answers them, folded over every
   * entry but a user's rename (`RENAME_ENTRY_TYPE`): what the SDK's listing
   * shows over them is the provider's own title, never one mirrored in.
   */
  listUnrenamedSummaries(projectKey: string): Promise<SessionSummaryEntry[]>;
  /** Copies everything stored under one harness session to another, inside the transaction open now: a fork (#137). */
  copySession(tx: Tx, fromSessionId: string, toSessionId: string): void;
  /** Deletes everything stored under a harness session, inside the transaction open now: the purge's cascade. */
  purgeSession(tx: Tx, sessionId: string): void;
}

export interface ProviderTranscriptStoreOptions {
  readonly log: Pick<EventLog, "atomically" | "providerTranscripts">;
  /** Stamps a summary's storage write time, which `listSessions` answers too. */
  readonly clock: Pick<Clock, "now">;
}

/** The table's key for an SDK key; an empty subpath is refused, as the SDK's contract says it is invalid. */
const keyOf = (key: SessionKey): TranscriptKey => {
  if (key.subpath === "") throw new Error("A session key's subpath is never empty: the main transcript has none.");
  return { projectKey: key.projectKey, sessionId: key.sessionId, subpath: key.subpath ?? "" };
};

const summaryEntry = (stored: StoredSummary, data: string): SessionSummaryEntry => ({
  sessionId: stored.sessionId,
  mtime: stored.mtime,
  data: JSON.parse(data) as Record<string, unknown>,
});

export const createProviderTranscriptStore = (options: ProviderTranscriptStoreOptions): ProviderTranscriptStore => {
  const { log, clock } = options;
  const table = log.providerTranscripts;

  return {
    async append(key, entries) {
      const stored = keyOf(key);
      if (entries.length === 0) return;
      const rows = entries.map((entry) => ({ uuid: typeof entry.uuid === "string" && entry.uuid !== "" ? entry.uuid : null, json: JSON.stringify(entry) }));
      log.atomically((tx) => {
        const kept = table.insert(tx, stored, rows).map((index) => entries[index] as SessionStoreEntry);
        // A subagent transcript never contributes to the main session's summary; a batch stored already folds nothing again.
        if (stored.subpath !== "" || kept.length === 0) return;
        const previous = table.summary(stored.projectKey, stored.sessionId);
        // The storage write time, rising strictly so the latest write is always the latest summary.
        const mtime = Math.max(clock.now().getTime(), table.latestMtime() + 1);
        const fold = (data: string | undefined, batch: SessionStoreEntry[]) =>
          foldSessionSummary(previous === null || data === undefined ? undefined : summaryEntry(previous, data), key, batch, { mtime });
        const data = fold(previous?.data, kept);
        const unrenamed = fold(previous?.unrenamed, kept.filter((entry) => entry.type !== RENAME_ENTRY_TYPE));
        table.writeSummary(tx, stored.projectKey, { sessionId: stored.sessionId, mtime, data: JSON.stringify(data.data), unrenamed: JSON.stringify(unrenamed.data) });
      });
    },
    async load(key) {
      const lines = table.load(keyOf(key));
      return lines.length === 0 ? null : lines.map((line) => JSON.parse(line) as SessionStoreEntry);
    },
    async listSessions(projectKey) {
      return table.summaries(projectKey).map((summary) => ({ sessionId: summary.sessionId, mtime: summary.mtime }));
    },
    async listSessionSummaries(projectKey) {
      return table.summaries(projectKey).map((summary) => summaryEntry(summary, summary.data));
    },
    async listUnrenamedSummaries(projectKey) {
      return table.summaries(projectKey).map((summary) => summaryEntry(summary, summary.unrenamed));
    },
    async delete(key) {
      const stored = keyOf(key);
      log.atomically((tx) => table.delete(tx, stored));
    },
    async listSubkeys(key) {
      return table.subkeys(key.projectKey, key.sessionId);
    },
    copySession: (tx, fromSessionId, toSessionId) => table.copyProject(tx, fromSessionId, toSessionId),
    purgeSession: (tx, sessionId) => table.purgeProject(tx, sessionId),
  };
};
