import {
  getSubagentMessages as sdkGetSubagentMessages,
  listSessions as sdkListSessions,
  renameSession as sdkRenameSession,
  type GetSessionMessagesOptions,
  type SessionMessage,
  type SessionStore,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject } from "@agent-harness/contracts";
import type { ConfigDirQueue } from "./config-dir-queue.js";
import type { ResumePoint } from "./options.js";

/**
 * The stored chain, read for where a fork or a rewind re-enters it
 * (claude-adapter spec, "Queue, read-now, fork and rewind on the Claude
 * adapter"; Artemis's `history.ts`, the part a run needs). A client points
 * at a user message by the id the harness minted, which is the uuid the
 * prompt was stamped with; a truncating resume re-enters at the entry
 * before it, and only the stored chain knows which entry that is.
 *
 * And the session store read through the SDK's own helpers (#137): the
 * provider's generated title from the store-backed listing, a user title
 * mirrored through the SDK's rename, and a subagent's transcript read on
 * demand. Those helpers take no environment and key a store by the process's
 * `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` (0.3.281's
 * `projectKey` resolution), which name no harness session here, so each is
 * handed the store scoped to the session (`scopedStore`) rather than the
 * process's environment being set under the queue.
 */

/**
 * The environment's store as the Claude adapter takes it: the SDK's
 * interface, and the summaries folded without the user's renames
 * (`provider-transcripts/store.ts`), which the title read lists.
 */
export interface ClaudeSessionStore extends SessionStore {
  listUnrenamedSummaries(projectKey: string): Promise<SessionSummaryEntry[]>;
}

/**
 * The store as the SDK's helpers see it for one harness session: whatever
 * project key a helper asks with, the session's own. A run's query needs no
 * such view: its environment names the project directory, and the SDK keys
 * its loads and the mirror by that.
 */
export const scopedStore = (store: SessionStore, projectKey: string): SessionStore => ({
  append: (key, entries) => store.append({ ...key, projectKey }, entries),
  load: (key) => store.load({ ...key, projectKey }),
  ...(store.listSessions !== undefined && { listSessions: () => (store.listSessions as NonNullable<SessionStore["listSessions"]>).call(store, projectKey) }),
  ...(store.listSessionSummaries !== undefined && {
    listSessionSummaries: () => (store.listSessionSummaries as NonNullable<SessionStore["listSessionSummaries"]>).call(store, projectKey),
  }),
  ...(store.delete !== undefined && { delete: (key) => (store.delete as NonNullable<SessionStore["delete"]>).call(store, { ...key, projectKey }) }),
  ...(store.listSubkeys !== undefined && {
    listSubkeys: (key) => (store.listSubkeys as NonNullable<SessionStore["listSubkeys"]>).call(store, { ...key, projectKey }),
  }),
});

/** The provider conversations stored under a harness session, the latest written first. */
const storedConversations = async (store: SessionStore, sessionId: string): Promise<string[]> =>
  ((await store.listSessions?.(sessionId)) ?? [])
    .slice()
    .sort((a, b) => b.mtime - a.mtime)
    .map((listed) => listed.sessionId);

/**
 * The title the provider generated for a harness session, from the SDK's
 * store-backed listing over the summaries folded without the user's renames:
 * the listing's `customTitle` is the provider's own title there (0.3.281
 * folds the CLI's `ai-title` entries into it, and a user's rename only into
 * the summaries the view leaves out), so a title the harness mirrored in is
 * never read back. The latest conversation that has one; null when none has.
 */
export const readGeneratedTitle = async (store: ClaudeSessionStore, sessionId: string): Promise<string | null> => {
  const view: SessionStore = { ...scopedStore(store, sessionId), listSessionSummaries: () => store.listUnrenamedSummaries(sessionId) };
  const listed = await sdkListSessions({ sessionStore: view });
  return listed.find((info) => info.customTitle !== undefined && info.customTitle.trim() !== "")?.customTitle ?? null;
};

/**
 * Mirrors a user title into the provider's own title field through the
 * SDK's rename, on the harness session's latest stored conversation;
 * false when the store holds none yet.
 */
export const mirrorUserTitle = async (store: SessionStore, sessionId: string, title: string): Promise<boolean> => {
  const [latest] = await storedConversations(store, sessionId);
  if (latest === undefined) return false;
  await sdkRenameSession(latest, title, { sessionStore: scopedStore(store, sessionId) });
  return true;
};

/**
 * A subagent's transcript as the store holds it, through the SDK's helper:
 * from the latest conversation of the harness session that has one, its
 * messages as JSON, oldest first; empty when none does.
 */
export const readSubagentTranscript = async (store: SessionStore, sessionId: string, agentId: string): Promise<JsonObject[]> => {
  const view = scopedStore(store, sessionId);
  for (const conversation of await storedConversations(store, sessionId)) {
    const messages = await sdkGetSubagentMessages(conversation, agentId, { sessionStore: view });
    if (messages.length > 0) return messages.map((message) => JSON.parse(JSON.stringify(message)) as JsonObject);
  }
  return [];
};

/** One entry of the stored chain, as the SDK's session helper reads it. */
export interface StoredMessage {
  readonly type: string;
  readonly uuid: string;
  readonly message?: unknown;
}

interface Block {
  readonly type?: unknown;
  readonly text?: unknown;
}

const blocksOf = (message: unknown): Block[] => {
  if (message === null || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Block => block !== null && typeof block === "object") : [];
};

/** What the CLI records in a user slot when a turn is stopped. */
const isInterruptMarker = (text: unknown): boolean => text === "[Request interrupted by user]" || text === "[Request interrupted by user for tool use]";

/**
 * Whether an entry after a prompt belongs to that prompt's turn, as the
 * provider's `--resume-drops-turn` validator judges it: the turn's answers,
 * its tool results and a stop's marker. A task notification the model
 * answered after the turn is a second exchange, and declaring the turn over
 * it is what the provider refuses.
 */
const belongsToTurn = (stored: StoredMessage): boolean => {
  if (stored.type !== "user") return true;
  const blocks = blocksOf(stored.message);
  if (blocks.some((block) => block.type === "tool_result")) return true;
  return blocks.length > 0 && blocks.every((block) => block.type === "text" && isInterruptMarker(block.text));
};

/**
 * "Rewind to just before this prompt": the entry before it, and the prompt
 * as the dropped turn when everything after it is that turn's, the only
 * shape the provider's acknowledgement vouches for. Null when the prompt is
 * not in the chain or nothing comes before it (a rewind to the first
 * message is a new session).
 */
export const resolveRewindPoint = (messages: readonly StoredMessage[], promptUuid: string): ResumePoint | null => {
  const at = messages.findIndex((stored) => stored.uuid === promptUuid);
  const before = at > 0 ? messages[at - 1] : undefined;
  if (before === undefined) return null;
  const oneTurn = messages.slice(at + 1).every(belongsToTurn);
  return oneTurn ? { resumeSessionAt: before.uuid, dropsTurn: promptUuid } : { resumeSessionAt: before.uuid };
};

/** A fork from a message: the session up to but excluding it, so the entry before it, dropping nothing. */
export const resolveForkPoint = (messages: readonly StoredMessage[], promptUuid: string): ResumePoint | null => {
  const at = messages.findIndex((stored) => stored.uuid === promptUuid);
  const before = at > 0 ? messages[at - 1] : undefined;
  return before === undefined ? null : { resumeSessionAt: before.uuid };
};

export interface StoredSessionRead {
  readonly queue: ConfigDirQueue;
  /** The harness session the conversation is stored under: the store's project key. */
  readonly harnessSessionId: string;
  /** The account's config directory, resolved. */
  readonly directory: string;
  readonly providerSessionId: string;
  readonly sessionStore: SessionStore | null;
  /** The SDK's helper; injected so the adapter hands in the one it imported. */
  readonly getSessionMessages: (sessionId: string, options: GetSessionMessagesOptions) => Promise<SessionMessage[]>;
}

/**
 * The stored chain of a provider session: the SDK's standalone helper, which
 * reads the config directory from the process environment, so under the
 * config-directory queue; from the environment's store when there is one,
 * scoped to the harness session the conversation is stored under (a fork's
 * own copy of its source's, #137).
 */
export const readStoredSession = async (read: StoredSessionRead): Promise<StoredMessage[]> => {
  const options: GetSessionMessagesOptions = read.sessionStore === null ? {} : { sessionStore: scopedStore(read.sessionStore, read.harnessSessionId) };
  const messages = await read.queue.run(read.directory, () => read.getSessionMessages(read.providerSessionId, options));
  return messages.map(({ type, uuid, message }) => ({ type, uuid, message }));
};
