import { randomUUID } from "node:crypto";
import {
  ContractError,
  DEFAULT_TITLE,
  GroupPatch,
  LIST_PATCH_KEY,
  SummaryPatch,
  registry,
  type EventEnvelope,
  type EventFrame,
  type Group,
  type MethodName,
  type ParamsOf,
  type ResponseOf,
  type SessionSummary,
} from "@agent-harness/contracts";
import { MANUAL_CLOCK_START } from "./clock.js";
import type { WireClient } from "./wire-client.js";

/**
 * What the session-organisation suites share: sending the session
 * commands as a client does, the session list as a client subscribes to
 * it, the patch an event carries, and a client's reduction of the list.
 */

/** The workspace every test session is created in. */
export const workspace = { kind: "directory", path: "/work/agent-harness" } as const;

type CreateParams = Omit<ParamsOf<"sessions.create">, "commandId" | "id" | "workspace"> & { id?: string; commandId?: string };

/** Sends `sessions.create` for a fresh id (or the one given) in the test workspace; resolves with what its response carries. */
export const create = async (client: WireClient, params: CreateParams = {}) => {
  const id = params.id ?? randomUUID();
  const response = registry["sessions.create"].response.parse(
    await client.request("sessions.create", { commandId: randomUUID(), workspace, ...params, id }),
  );
  return { id, ...response };
};

/** Sends `sessions.rename`; resolves with what its response carries. */
export const rename = async (client: WireClient, sessionId: string, title: string | null, commandId = randomUUID()) =>
  registry["sessions.rename"].response.parse(await client.request("sessions.rename", { commandId, sessionId, title }));

/** A command on one session: its params but the command id, which `command` mints unless given. */
type SessionCommandParams<N extends MethodName> = Omit<ParamsOf<N>, "commandId"> & { commandId?: string };

/** The session commands that answer with the summary, by name. */
export type SessionCommand =
  | "sessions.archive"
  | "sessions.unarchive"
  | "sessions.pin"
  | "sessions.unpin"
  | "sessions.reorderPinned"
  | "sessions.reorderActive"
  | "sessions.tag"
  | "sessions.untag"
  | "sessions.setDraft";

/** Sends a session command with a fresh command id (unless one is given); resolves with what its response carries, checked against its schema. */
export const command = async <N extends SessionCommand>(client: WireClient, method: N, params: SessionCommandParams<N>): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** The summary `sessions.get` answers. */
export const get = async (client: WireClient, sessionId: string): Promise<SessionSummary> =>
  (await client.request("sessions.get", { sessionId })).summary;

/** The code and data a request was refused with; throws if it was answered. */
export const refusal = async (request: Promise<unknown>): Promise<{ code: string; data: Record<string, unknown> }> => {
  try {
    await request;
  } catch (error) {
    if (error instanceof ContractError) return { code: error.code, data: error.data };
    throw error;
  }
  throw new Error("The request was answered, not refused.");
};

/** A summary as a session created at the manual clock's start in the test workspace has it. */
export const freshSummary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  createdAt: MANUAL_CLOCK_START,
  updatedAt: MANUAL_CLOCK_START,
  lastActivityAt: null,
  title: DEFAULT_TITLE,
  titleSource: "default",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace,
  repositoryIdentity: null,
  activity: { state: "idle", since: MANUAL_CLOCK_START },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  pullRequests: [],
  draft: null,
  ...overrides,
});

/** The session list a client has subscribed to: its subscription, and the next event on it. */
export interface ListStream {
  readonly subscription: string;
  next(): Promise<EventEnvelope>;
}

/**
 * The session list as a client sees it: subscribed from `afterSequence`,
 * every event frame kept in order. `next` waits for the next event.
 */
export const listStream = async (client: WireClient, afterSequence: number): Promise<ListStream> => {
  const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence });
  const next = async (): Promise<EventEnvelope> => {
    const frame = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    return frame.event;
  };
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  return { subscription, next };
};

/** The summary patch an event carries in its metadata, checked against the contracts' schema. */
export const patchOf = (event: EventEnvelope) => SummaryPatch.parse(event.metadata[LIST_PATCH_KEY]);

/**
 * A client's reduction of the session list: a snapshot, then every patch
 * applied in order, and nothing read from a payload (session-state spec,
 * "The list stream and the summary patch").
 */
export const reduce = (snapshot: { sessions: readonly SessionSummary[]; groups: readonly Group[] }, events: readonly EventEnvelope[]) => {
  const sessions = new Map(snapshot.sessions.map((summary) => [summary.id, summary]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  for (const event of events) {
    if (event.streamKind === "group") {
      const patch = GroupPatch.parse(event.metadata[LIST_PATCH_KEY]);
      if (patch.op === "add") groups.set(patch.group.id, patch.group);
      else if (patch.op === "remove") groups.delete(patch.groupId);
      else groups.set(patch.groupId, { ...(groups.get(patch.groupId) as Group), ...patch.fields } as Group);
      continue;
    }
    const patch = patchOf(event);
    if (patch.op === "add") sessions.set(patch.summary.id, patch.summary);
    else if (patch.op === "remove") sessions.delete(patch.sessionId);
    else sessions.set(patch.sessionId, { ...(sessions.get(patch.sessionId) as SessionSummary), ...patch.fields } as SessionSummary);
  }
  const byId = <T extends { id: string }>(items: Iterable<T>) => [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { sessions: byId(sessions.values()), groups: byId(groups.values()) };
};
