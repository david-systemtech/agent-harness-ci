import {
  ACCESS_EVENT_PAYLOADS,
  AccessEventType,
  SCOPES,
  scopesInWords,
  type AccessEventPayload,
  type Ceiling,
  type ClientKind,
  type EventEnvelope,
  type ResultOf,
  type Scope,
} from "@agent-harness/contracts";
import { DENYLIST_SECTION_NAMES } from "../permissions/words.js";
import { whenWords } from "../transcript/format.js";

/**
 * What the Access row says (env spec, "Pairing and access"; permissions
 * spec, "Ceilings"; docs/specs/gui.md, "Settings"; #417), as any renderer
 * says it: a client session's kind, scopes and when it was last seen, what
 * a pairing grants, and each access log event in one line.
 */

/** A client session as `access.sessions.list` lists it. */
export type ClientSessionSummary = ResultOf<"access.sessions.list">["sessions"][number];

/** What each kind of client is called. */
export const CLIENT_KIND_NAMES: Readonly<Record<ClientKind, string>> = {
  desktop: "Desktop window",
  tui: "Terminal UI",
  web: "Browser tab",
  program: "Program",
};

/** The scopes a client session holds: "every scope", or each in the contracts' order. */
export const scopesWords = (scopes: readonly Scope[]): string =>
  SCOPES.every((scope) => scopes.includes(scope)) ? "every scope" : SCOPES.filter((scope) => scopes.includes(scope)).join(", ");

/** What a client session is, in one line: `Desktop window · every scope · last seen 14:02`. */
export const clientSessionWords = (session: ClientSessionSummary, now: Date): string =>
  `${CLIENT_KIND_NAMES[session.kind]} · ${scopesWords(session.scopes)} · ${session.lastSeenAt === null ? "never seen" : `last seen ${whenWords(session.lastSeenAt, now)}`}`;

/** Why this client cannot change its own ceiling, in the environment's words: another client session with `admin` can. */
export const OWN_CEILING = "A client session cannot change its own ceiling; another admin session can.";

/** What a pairing code grants: `Grants read, sessions:write and runs:drive, up to acceptEdits.` */
export const grantWords = (scopes: readonly Scope[], ceiling: Ceiling): string => `Grants ${scopesInWords(scopes)}, up to ${ceiling}.`;

/** When an access event happened, where the client is: its clock time today, else its day too. */
export const accessEventTimeWords = (event: Pick<EventEnvelope, "occurredAt">, now: Date): string => whenWords(event.occurredAt, now);

/** An event's payload read as its type's, or undefined when it is not one. */
const payloadOf = <T extends AccessEventType>(type: T, payload: unknown): AccessEventPayload<T> | undefined => {
  const read = ACCESS_EVENT_PAYLOADS[type].safeParse(payload);
  return read.success ? (read.data as AccessEventPayload<T>) : undefined;
};

/** Why a client session was revoked, after its label. */
const REVOKED_WHY = {
  requested: "was revoked",
  replaced: "was revoked: a newer desktop window on its machine replaced it",
  idle: "was revoked: its last socket closed an hour before",
} as const;

/** What an access event says, by its type, given its payload and how a client session is named. */
const eventLine = (event: Pick<EventEnvelope, "type" | "payload">, labelOf: (clientSessionId: string) => string): string | undefined => {
  const type = AccessEventType.safeParse(event.type);
  if (!type.success) return undefined;
  switch (type.data) {
    case "pairing.created": {
      const read = payloadOf(type.data, event.payload);
      return read && `A pairing code was made. ${grantWords(read.scopes, read.ceiling)}`;
    }
    case "pairing.exchanged": {
      const read = payloadOf(type.data, event.payload);
      return read && `A pairing code was exchanged for ${labelOf(read.clientSessionId)}.`;
    }
    case "pairing.expired":
      return "A pairing code expired unused.";
    case "client-session.created": {
      const read = payloadOf(type.data, event.payload);
      const how = read?.how === "bootstrap" ? "through the bootstrap grant on this environment's machine" : "by a pairing code";
      return read && `${read.label} (${CLIENT_KIND_NAMES[read.kind]}) was let in ${how}, with ${scopesWords(read.scopes)}, up to ${read.ceiling}.`;
    }
    case "client-session.refreshed": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)} renewed its token.`;
    }
    case "client-session.revoked": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)} ${REVOKED_WHY[read.reason]}.`;
    }
    case "socket.opened": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)} connected${read.remoteAddress === null ? "" : ` from ${read.remoteAddress}`}.`;
    }
    case "socket.closed": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)} disconnected.`;
    }
    case "scope.granted": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)} was granted ${scopesWords(read.granted)}.`;
    }
    case "access.changed": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)}'s access changed from ${scopesWords(read.from.scopes)} up to ${read.from.ceiling} to ${scopesWords(read.to.scopes)} up to ${read.to.ceiling}.`;
    }
    case "ceiling.changed": {
      const read = payloadOf(type.data, event.payload);
      return read && `${labelOf(read.clientSessionId)}'s ceiling went from ${read.from} to ${read.to}.`;
    }
    case "bypass.acknowledged": {
      const read = payloadOf(type.data, event.payload);
      return read && `bypassPermissions was acknowledged for ${read.setting}.`;
    }
    case "settings.changed": {
      const read = payloadOf(type.data, event.payload);
      return read && `Permission settings changed: ${read.keys.join(", ")}.`;
    }
    case "denylist.changed": {
      const read = payloadOf(type.data, event.payload);
      return read && `The denylist's ${DENYLIST_SECTION_NAMES[read.section].toLowerCase()} changed: ${read.added.length} added, ${read.removed.length} removed, ${read.edited.length} edited.`;
    }
  }
};

/**
 * An access log event in one line, a client session named by its label
 * (`labelOf`): `laptop connected from 100.64.0.7.`, `laptop's ceiling went
 * from acceptEdits to plan.`; an event this client does not know, or whose
 * payload is not its type's, by its type.
 */
export const accessEventWords = (event: Pick<EventEnvelope, "type" | "payload">, labelOf: (clientSessionId: string) => string): string =>
  eventLine(event, labelOf) ?? `${event.type}.`;

/**
 * How the access log names a client session: its label as the client
 * sessions listed or the log's `client-session.created` say it, else
 * "client session" and the start of its id.
 */
export const clientSessionLabels = (sessions: readonly Pick<ClientSessionSummary, "id" | "label">[], events: readonly Pick<EventEnvelope, "type" | "payload">[]) => {
  const labels = new Map(sessions.map((session) => [session.id, session.label]));
  for (const event of events) {
    const created = event.type === "client-session.created" ? payloadOf("client-session.created", event.payload) : undefined;
    if (created !== undefined && !labels.has(created.clientSessionId)) labels.set(created.clientSessionId, created.label);
  }
  return (clientSessionId: string): string => labels.get(clientSessionId) ?? `client session ${clientSessionId.slice(0, 8)}`;
};
