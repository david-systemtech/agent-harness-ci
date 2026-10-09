import type { GetSessionMessagesOptions, GetSubagentMessagesOptions, ListSubagentsOptions, SessionMessage, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AttachmentRecord } from "@agent-harness/contracts";
import { HISTORY_EVENT_TYPES, type HistoryEvent } from "../../adapter/contract.js";
import type { Clock } from "../../serve/clock.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";
import { isInterruptMarker, scopedStore } from "./history.js";
import { createMapperState, endTurn, mapSdkMessage } from "./mapper.js";
import { SpendMeter } from "./spend.js";
import { TaskLedger } from "./tasks.js";

/**
 * An imported session's history, read from the account's directory (ADR
 * 0021; #579), and the copy of it the session store takes before the
 * session's first run.
 *
 * The history is what the SDK's standalone helpers read of the provider
 * session's transcript and its subagent transcripts (`getSessionMessages`,
 * `listSubagents`, `getSubagentMessages`), under the config-directory queue,
 * mapped to the transcript vocabulary by the mapper a live run's messages
 * go through: the assistant's words and tool calls, and a subagent's calls
 * nested under the call that started it, right after that call's start. A
 * user message is the harness's to record as sent, so it is mapped here:
 * its text and its images, the interrupt markers the CLI records in a
 * user's place left out. Each settled item is named by the record's own
 * uuid, since the CLI writes a message's blocks as records of their own
 * under one message id. A call the transcript never ended ends cancelled.
 *
 * The copy: a resume whose provider session the store does not hold (an
 * imported session's first run) would have the CLI find the transcript in
 * the account's directory and go on writing it there, mirroring only what it
 * wrote, under the transcript's own project folder rather than the harness
 * session's, so the store would never take over (verified on the pinned SDK,
 * the PR of #579). So the transcript is imported into the store under the
 * harness session first, through the SDK's `importSessionToStore`, and the
 * run resumes from the store as any later run does, in a temporary copy of
 * the account's directory; the directory itself is only read.
 */

/** The SDK's helpers the read takes; injected so the adapter hands in the ones it imported. */
export interface HistoryHelpers {
  readonly getSessionMessages: (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>;
  readonly listSubagents: (sessionId: string, options?: ListSubagentsOptions) => Promise<string[]>;
  readonly getSubagentMessages: (sessionId: string, agentId: string, options?: GetSubagentMessagesOptions) => Promise<SessionMessage[]>;
}

export interface DirectoryHistoryRead extends HistoryHelpers {
  readonly queue: ConfigDirQueue;
  /** The account's config directory, resolved. */
  readonly directory: string;
  readonly providerSessionId: string;
  readonly clock: Pick<Clock, "now">;
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value);

const HISTORY_TYPES: ReadonlySet<string> = new Set(HISTORY_EVENT_TYPES);

/** When a record says it happened: its timestamp, undeclared on `SessionMessage` but on every record the CLI writes; null for none. */
const timestampOf = (message: SessionMessage): string | null => {
  const at = (message as unknown as Record_)["timestamp"];
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null;
};

/** The content blocks of a record's message; a string's is one text block. */
const blocksOf = (message: SessionMessage): Record_[] => {
  const content = isRecord(message.message) ? message.message["content"] : undefined;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/** An image block as the log records an attachment: its media type and size, never its bytes. */
const imageRecord = (block: Record_, index: number): AttachmentRecord | null => {
  const source = block["source"];
  if (block["type"] !== "image" || !isRecord(source) || source["type"] !== "base64" || typeof source["data"] !== "string") return null;
  const mediaType = typeof source["media_type"] === "string" && source["media_type"] !== "" ? source["media_type"] : "application/octet-stream";
  return { kind: "image", name: `image-${index + 1}`, mediaType, size: Buffer.byteLength(source["data"], "base64") };
};

/** A user record that is a person's message: its text and images; null for a tool's result, an interrupt marker or nothing. */
const userMessage = (message: SessionMessage, at: string | null): HistoryEvent | null => {
  const blocks = blocksOf(message);
  if (blocks.some((block) => block["type"] === "tool_result")) return null;
  const texts = blocks.flatMap((block) => (block["type"] === "text" && typeof block["text"] === "string" && !isInterruptMarker(block["text"]) ? [block["text"]] : []));
  const attachments = blocks.filter((block) => block["type"] === "image").flatMap((block, index) => imageRecord(block, index) ?? []);
  const text = texts.join("\n\n");
  if (text.trim() === "" && attachments.length === 0) return null;
  return { type: "message.sent", payload: { text, attachments }, at };
};

/**
 * A record as the mapper takes a live run's message: the SDK message shape,
 * its message's id replaced by the record's uuid, so each record's blocks
 * are items of their own.
 */
const asSdkMessage = (message: SessionMessage): Record_ => ({
  type: message.type,
  uuid: message.uuid,
  session_id: message.session_id,
  parent_tool_use_id: message.parent_tool_use_id,
  message: isRecord(message.message) ? { ...message.message, id: message.uuid } : message.message,
});

/** A thread's mapper: the time it reads for a call's duration is the record's, as each is mapped. */
const threadMapper = (clock: Pick<Clock, "now">): { map(message: SessionMessage, at: string | null): HistoryEvent[]; close(at: string | null): HistoryEvent[] } => {
  let now = clock.now().getTime();
  const state = createMapperState({ ledger: new TaskLedger(clock), spend: new SpendMeter(), now: () => now });
  const kept = (events: readonly { readonly type: string }[], at: string | null): HistoryEvent[] =>
    events.filter((event) => HISTORY_TYPES.has(event.type)).map((event) => ({ ...(event as Omit<HistoryEvent, "at">), at }) as HistoryEvent);
  return {
    map(message, at) {
      if (at !== null) now = Date.parse(at);
      return kept(mapSdkMessage(asSdkMessage(message), state), at);
    },
    // The calls the transcript never ended, ended cancelled, as a run's end ends them.
    close: (at) => kept(endTurn(state, { reason: "completed" }), at),
  };
};

/** A subagent's calls, each nested under the call that started it: what the mapper makes of its records. */
const subagentEvents = (messages: readonly SessionMessage[], clock: Pick<Clock, "now">): HistoryEvent[] => {
  const mapper = threadMapper(clock);
  const events = messages.flatMap((message) => mapper.map(message, timestampOf(message)));
  return [...events, ...mapper.close(events.at(-1)?.at ?? null)];
};

/**
 * The history of `providerSessionId` in the account's directory, oldest
 * first; null when the directory holds no transcript of it. Read through
 * the SDK's helpers under the config-directory queue.
 */
export const readDirectoryHistory = async (read: DirectoryHistoryRead): Promise<HistoryEvent[] | null> => {
  const { providerSessionId: id } = read;
  const found = await read.queue.run(read.directory, async () => {
    const main = await read.getSessionMessages(id);
    if (main.length === 0) return null;
    const agents = await read.listSubagents(id);
    const subagents: SessionMessage[][] = [];
    for (const agent of agents) subagents.push(await read.getSubagentMessages(id, agent));
    return { main, subagents };
  });
  if (found === null) return null;
  // Each subagent's calls, by the call that started it; one whose transcript names none has nothing to nest under.
  const nested = new Map<string, HistoryEvent[]>();
  for (const messages of found.subagents) {
    const parent = messages.find((message) => message.parent_tool_use_id !== null)?.parent_tool_use_id;
    if (parent === undefined || parent === null) continue;
    nested.set(parent, [...(nested.get(parent) ?? []), ...subagentEvents(messages, read.clock)]);
  }
  const mapper = threadMapper(read.clock);
  const history: HistoryEvent[] = [];
  for (const message of found.main) {
    if (message.type !== "user" && message.type !== "assistant") continue;
    const at = timestampOf(message);
    const sent = message.type === "user" ? userMessage(message, at) : null;
    if (sent !== null) {
      history.push(sent);
      continue;
    }
    for (const event of mapper.map(message, at)) {
      history.push(event);
      if (event.type !== "tool.started") continue;
      history.push(...(nested.get(event.payload.toolCallId) ?? []));
      nested.delete(event.payload.toolCallId);
    }
  }
  const last = history.at(-1)?.at ?? null;
  // A subagent whose call the main transcript does not hold still ran: its calls come last.
  return [...history, ...[...nested.values()].flat(), ...mapper.close(last)];
};

export interface StoreSeed {
  readonly queue: ConfigDirQueue;
  /** A listed import source must hydrate successfully; it cannot fall back to an Account transcript. */
  readonly required?: boolean;
  /** The account or retained source directory, resolved. */
  readonly directory: string;
  /** The harness session the store keeps the provider session under: its project key. */
  readonly harnessSessionId: string;
  readonly providerSessionId: string;
  readonly store: SessionStore;
  /** The SDK's `importSessionToStore`; injected so the adapter hands in the one it imported. */
  readonly importSessionToStore: (sessionId: string, store: SessionStore) => Promise<void>;
}

/**
 * Before a resume: the store takes the provider session from the account's
 * directory, subagent transcripts and all, when it holds nothing of it under
 * the harness session yet (an imported session's first run). True when it
 * copied; false when the store held it already or the directory holds no
 * transcript of it, when the resume goes on as it would have.
 */
export const seedStoreFromDirectory = async (seed: StoreSeed): Promise<boolean> => {
  const key = { projectKey: seed.harnessSessionId, sessionId: seed.providerSessionId };
  const existing = await seed.store.load(key);
  if (existing !== null && existing.length > 0) return false;
  const scoped = scopedStore(seed.store, seed.harnessSessionId);
  return seed.queue.run(seed.directory, async () => {
    const held = await seed.store.load(key);
    if (held !== null && held.length > 0) return false;
    // The main transcript is the completion evidence. Publish it in one owning-store append only after
    // every subagent batch has succeeded; an interruption then leaves no partial main to resume from.
    const main: SessionStoreEntry[] = [];
    const importing: SessionStore = { ...scoped, append: async (key, entries) => {
      if (key.subpath === undefined) main.push(...entries);
      else await scoped.append(key, entries);
    } };
    try {
      await seed.importSessionToStore(seed.providerSessionId, importing);
      await seed.store.append(key, main);
      if (seed.required) {
        const copied = await seed.store.load({ projectKey: seed.harnessSessionId, sessionId: seed.providerSessionId });
        if (copied === null || copied.length === 0) throw new Error("The retained source has no usable transcript; this Session remains read-only.");
      }
      return true;
    } catch (error) {
      // The SDK refuses a session it cannot find; any other failure is the store's, and the run's to report.
      if (!seed.required && error instanceof Error && /not found/i.test(error.message)) return false;
      throw error;
    }
  });
};
