import {
  ACCESS_EVENT_PAYLOADS,
  ACCESS_STREAM_KIND,
  Ceiling,
  ScopeSet,
  EnvironmentStatus,
  SCOPES,
  registry,
  type AccessEventType,
  type DrainStarted,
  type EventEnvelope,
  type ResultOf,
  type SettingsValues,
} from "@agent-harness/contracts";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's access and lifecycle answers (env spec,
 * "Pairing and access", "Lifecycle"; permissions spec, "Ceilings"; #417):
 * `access.sessions.list` over the client sessions the script lists and this
 * client's own, `access.sessions.revoke`, `access.sessions.setCeiling` with
 * the environment's refusals (this client's own `own_session`, a revoked one
 * `revoked`, an unknown one `not_found`), `access.pairings.create` with the
 * scopes and ceiling asked (else every scope and the default ceiling), and
 * `access.log.list` over the access stream: the events the script lists,
 * then what those commands append, read after a cursor, oldest first. And
 * `environment.status` over what the script says of it, `environment.drain`
 * (a drain begun once, joined after, noticed as `environment.draining`) and
 * `environment.rebuildProjections`. The drain's end, `bye: draining`, is the
 * test's to say (`bye`).
 */

/** A client session as `access.sessions.list` lists it. */
export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

/** An event the access log holds from the start: its type and payload, checked against the type's schema, and when it happened (preset the clock's now). */
export interface ScriptedAccessEvent {
  readonly type: AccessEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

export interface ScriptedAccessHandle {
  /** The client sessions as the environment holds them now, this client's own last, revoked ones with when. */
  clientSessions(): readonly ClientSessionRow[];
  /** The access log as the environment holds it, oldest first. */
  accessLog(): readonly EventEnvelope[];
  /** The drain under way, from the first `environment.drain`; undefined while there is none. */
  drain(): DrainStarted | undefined;
}

export interface AccessHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  /** How this client reaches the environment, which its own client session's `local` says. */
  readonly local: boolean;
  readonly clientSessions: readonly Partial<ClientSessionRow>[] | undefined;
  readonly accessLog: readonly ScriptedAccessEvent[] | undefined;
  /** What `environment.status` says besides what the scripted discovery and a drain say. */
  readonly status: Partial<EnvironmentStatus> | undefined;
  /** The settings' values now, whose default ceiling a pairing asked for none gets. */
  settings(): SettingsValues;
  /** The stream's head now, which a receipt changing nothing names. */
  head(): number;
  /** Takes the next sequence: a change appended. */
  next(): number;
  /** A rejection the script names for `method`, if any. */
  refusal(method: string): FakeAnswer | undefined;
  /** A query's refusal the script names for `method`, as an error response with its reason as the code. */
  queryRefusal(method: string): FakeAnswer | undefined;
  /** Says a notice on the environment's own stream. */
  notice(type: string, payload: Record<string, unknown>): void;
}

/** The commands this module answers itself, so a receipt the script names is its refusal rather than a generic answer. */
export const ACCESS_COMMANDS: readonly string[] = [
  "access.sessions.list",
  "access.sessions.revoke",
  "access.sessions.setCeiling",
  "access.sessions.setAccess",
  "access.pairings.create",
  "access.log.list",
  "environment.status",
  "environment.drain",
  "environment.rebuildProjections",
];

/** A client session row's schema: contracts exports none by name, so it is read off `access.sessions.list`'s result. */
const ClientSessionRowSchema = registry["access.sessions.list"].result.shape.sessions.element;

/** The projectors `environment.rebuildProjections` says it rebuilt. */
const PROJECTORS = ["sessions", "groups", "runs", "client-sessions", "settings"] as const;

/** A scripted client session, over a desktop one with every scope and bypassPermissions, seen and made now, for thirty days. */
const clientSessionOf = (clock: ManualClock, partial: Partial<ClientSessionRow>, index: number): ClientSessionRow => {
  const at = clock.now().toISOString();
  return ClientSessionRowSchema.parse({
    id: `0199cc00-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "desktop",
    label: `client ${index + 1}`,
    createdAt: at,
    lastSeenAt: at,
    expiresAt: new Date(clock.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    revokedAt: null,
    scopes: [...SCOPES],
    ceiling: Ceiling.parse("bypassPermissions"),
    local: false,
    ...partial,
  });
};

export const scriptedAccess = (host: AccessHost): ScriptedAccessHandle => {
  const { clock, wire } = host;
  const others = (host.clientSessions ?? []).map((c, i) => clientSessionOf(clock, c, i));
  const revoked = new Map<string, string>();
  const grants = new Map<string, ResultOf<"access.sessions.setAccess">>();
  const ceilings = new Map<string, Ceiling>();
  const log: EventEnvelope[] = [];

  /** The client session this client holds, as the environment lists it. */
  const own = (): ClientSessionRow | undefined => {
    const credential = wire.credential();
    return credential === undefined
      ? undefined
      : clientSessionOf(clock, { id: credential.clientSessionId, kind: "tui", label: "milo@desk:pts/3", local: host.local, ceiling: credential.ceiling }, others.length);
  };
  const clientSessions = (): ClientSessionRow[] => {
    const mine = own();
    return [...others, ...(mine === undefined ? [] : [mine])].map((c) => ({ ...c, ...grants.get(c.id), ceiling: ceilings.get(c.id) ?? grants.get(c.id)?.ceiling ?? c.ceiling, revokedAt: revoked.get(c.id) ?? c.revokedAt }));
  };

  /** Appends an access event, as the command's client session (this client's own) or the script. */
  const append = (type: AccessEventType, payload: Record<string, unknown>, sequence: number, occurredAt = clock.now().toISOString()) => {
    const actor = own();
    log.push({
      sequence,
      eventId: `0199ac00-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
      streamKind: ACCESS_STREAM_KIND,
      streamId: wire.environmentId,
      streamVersion: log.length + 1,
      type,
      occurredAt,
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: actor === undefined ? { kind: "system", id: "script" } : { kind: "client_session", id: actor.id },
      payload: ACCESS_EVENT_PAYLOADS[type].parse(payload) as Record<string, unknown>,
      metadata: {},
    });
  };
  for (const event of host.accessLog ?? []) append(event.type, { ...event.payload }, host.next(), event.occurredAt);

  const accepted = (result: Record<string, unknown>, changed = true): FakeAnswer => ({
    result: { receipt: { status: "accepted", sequence: changed ? host.next() : host.head(), changed }, result },
  });
  const rejected = (code: string, message: string, data: Record<string, unknown> = {}): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: host.next(), changed: false, reason: code, error: { code, message, data } } },
  });

  wire.answer("access.sessions.list", (params) => {
    const refused = host.queryRefusal("access.sessions.list");
    if (refused) return refused;
    const listed = clientSessions();
    return { result: { sessions: params["live"] === true ? listed.filter((c) => c.revokedAt === null) : listed } };
  });

  wire.answer("access.sessions.revoke", (params) => {
    const refused = host.refusal("access.sessions.revoke");
    if (refused) return refused;
    const id = String(params["clientSessionId"]);
    const held = revoked.get(id);
    if (held !== undefined) return accepted({ revokedAt: held }, false);
    const at = clock.now().toISOString();
    revoked.set(id, at);
    const answer = accepted({ revokedAt: at });
    append("client-session.revoked", { clientSessionId: id, reason: "requested" }, host.head());
    return answer;
  });

  // Permissions spec, "Ceilings": no client session changes its own ceiling; a revoked one's is refused, an unknown one is not found.
  wire.answer("access.sessions.setCeiling", (params) => {
    const refused = host.refusal("access.sessions.setCeiling");
    if (refused) return refused;
    const id = String(params["clientSessionId"]);
    const to = Ceiling.parse(params["ceiling"]);
    if (id === own()?.id) return rejected("conflict", "A client session cannot change its own ceiling; another admin session can.", { reason: "own_session" });
    const target = clientSessions().find((c) => c.id === id);
    if (target === undefined) return rejected("not_found", `No client session is named ${id}.`);
    if (target.revokedAt !== null) return rejected("conflict", `The client session ${id} has been revoked.`, { reason: "revoked" });
    if (target.ceiling === to) return accepted({ clientSessionId: id, from: to, to }, false);
    ceilings.set(id, to);
    const answer = accepted({ clientSessionId: id, from: target.ceiling, to });
    append("ceiling.changed", { clientSessionId: id, from: target.ceiling, to }, host.head());
    return answer;
  });

  wire.answer("access.sessions.setAccess", (params) => {
    const refused = host.refusal("access.sessions.setAccess");
    if (refused) return refused;
    const id = String(params["clientSessionId"]);
    if (id === own()?.id) return rejected("conflict", "A client cannot change its own access.", { reason: "own_session" });
    const target = clientSessions().find((c) => c.id === id);
    if (!target) return rejected("not_found", `No client session is named ${id}.`);
    if (target.revokedAt !== null) return rejected("conflict", "This client is revoked.", { reason: "revoked" });
    const to = { scopes: ScopeSet.parse(params["scopes"]), ceiling: Ceiling.parse(params["ceiling"]) };
    const grant = { clientSessionId: id, ...to };
    grants.set(id, grant);
    ceilings.delete(id);
    const answer = accepted(grant);
    append("access.changed", { clientSessionId: id, from: { scopes: target.scopes, ceiling: target.ceiling }, to }, host.head());
    return answer;
  });

  let pairings = 0;
  wire.answer("access.pairings.create", (params) => {
    const refused = host.refusal("access.pairings.create");
    if (refused) return refused;
    pairings++;
    const code = `K7Q2MXH4R${"TVWXYZ"[pairings % 6]}`;
    const pairingId = `0199dd00-0000-7000-8000-${String(pairings).padStart(12, "0")}`;
    const expiresAt = new Date(clock.now().getTime() + 10 * 60 * 1000).toISOString();
    const scopes = Array.isArray(params["scopes"]) ? params["scopes"] : [...SCOPES];
    const ceiling = params["ceiling"] === undefined ? host.settings()["permissions.defaultCeiling"] : Ceiling.parse(params["ceiling"]);
    // An environment bound to loopback alone links its codes to loopback, as a real one does (environment/src/serve/start.ts).
    const binding = host.status?.binding;
    const origin = binding != null && binding.tailnet === null && binding.lan === null ? "http://127.0.0.1:7433" : wire.origin;
    const answer = accepted({ pairingId, code, link: `${origin}/pair#${code}`, expiresAt, scopes, ceiling });
    append("pairing.created", { pairingId, scopes, ceiling, expiresAt }, host.head());
    return answer;
  });

  wire.answer("access.log.list", (params) => {
    const refused = host.queryRefusal("access.log.list");
    if (refused) return refused;
    const after = typeof params["afterSequence"] === "number" ? params["afterSequence"] : 0;
    const limit = typeof params["limit"] === "number" ? params["limit"] : 100;
    return { result: { events: log.filter((event) => event.sequence > after).slice(0, limit) } };
  });

  let drain: DrainStarted | undefined;
  wire.answer("environment.status", () => ({
    result: EnvironmentStatus.parse({
      readiness: "ready",
      activity: { state: "idle" },
      updatesManagedOutside: false,
      ...host.status,
      ...(drain !== undefined && { readiness: "draining", activity: { state: "draining", drainingSince: drain.drainingSince } }),
    }),
  }));
  wire.answer("environment.drain", () => {
    const refused = host.refusal("environment.drain");
    if (refused) return refused;
    if (drain !== undefined) return accepted({ ...drain }, false);
    drain = { drainingSince: clock.now().toISOString(), trigger: "command" };
    const answer = accepted({ ...drain });
    host.notice("environment.draining", { ...drain });
    return answer;
  });
  wire.answer("environment.rebuildProjections", () => {
    const refused = host.refusal("environment.rebuildProjections");
    if (refused) return refused;
    // A rebuild appends nothing, so it is accepted unchanged at the head (env spec, command receipts).
    return accepted({ projectors: [...PROJECTORS], sequence: host.head() }, false);
  });

  return { clientSessions, accessLog: () => [...log], drain: () => drain };
};
