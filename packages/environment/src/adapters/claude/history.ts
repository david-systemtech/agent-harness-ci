import type { GetSessionMessagesOptions, SessionMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { ConfigDirQueue } from "./config-dir-queue.js";
import type { ResumePoint } from "./options.js";

/**
 * The stored chain, read for where a fork or a rewind re-enters it
 * (claude-adapter spec, "Queue, read-now, fork and rewind on the Claude
 * adapter"; Artemis's `history.ts`, the part a run needs). A client points
 * at a user message by the id the harness minted, which is the uuid the
 * prompt was stamped with; a truncating resume re-enters at the entry
 * before it, and only the stored chain knows which entry that is.
 * Replaying history into the transcript and subagent transcripts are #137's.
 */

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
  readonly directory: string | null;
  readonly providerSessionId: string;
  readonly sessionStore: SessionStore | null;
  /** The SDK's helper; injected so the adapter hands in the one it imported. */
  readonly getSessionMessages: (sessionId: string, options: GetSessionMessagesOptions) => Promise<SessionMessage[]>;
}

/**
 * The stored chain of a provider session: the SDK's standalone helper, which
 * reads the config directory from the process environment, so under the
 * config-directory queue; from the environment's store when there is one.
 */
export const readStoredSession = async (read: StoredSessionRead): Promise<StoredMessage[]> => {
  const options: GetSessionMessagesOptions = read.sessionStore === null ? {} : { sessionStore: read.sessionStore };
  const messages = await read.queue.run(read.directory, () => read.getSessionMessages(read.providerSessionId, options));
  return messages.map(({ type, uuid, message }) => ({ type, uuid, message }));
};
