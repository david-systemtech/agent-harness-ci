import type { GrantReader, HttpFetch, WebSocketFactory } from "@agent-harness/client-runtime";
import type { ManualClock } from "@agent-harness/client-runtime/testing";
import { fakeWire, type FakeAnswer, type FakeServer, type FakeWire } from "@agent-harness/client-runtime/testing/fake-wire";
import {
  Ceiling,
  DISCOVERY_PATH,
  PAIR_PATH,
  SCOPES,
  WIRE_PATH,
  registry,
  type ByeReason,
  type CapabilityFlags,
  type DiscoveryDocument,
  type Frame,
  Group,
  type HelloFrame,
  type ResultOf,
  type Scope,
  SessionSummary,
} from "@agent-harness/contracts";

/**
 * The scripted fake environment (docs/specs/tui.md, "Testing Decisions"):
 * the #126 fake wire extended with a script, one or two environments, each
 * with its sessions and groups, its client sessions, the receipts its
 * commands answer, how its pairing exchange refuses a code, and what its
 * discovery answers. A test drives it further through its handle: `bye`
 * reasons, a dropped socket, discovery answering `starting` or nothing.
 */

/** How a command is answered: accepted, or rejected with a reason (an error code) and a message. */
export type ScriptedReceipt = "accepted" | { readonly rejected: string; readonly message?: string };

/** What discovery answers: ready, starting, or nothing at all (nothing listens). */
export type ScriptedDiscovery = "ready" | "starting" | "nothing";

/** A client session as `access.sessions.list` lists it. */
export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

/** Why the pairing exchange refuses every code, as the environment answers it. */
export type ScriptedPairingRefusal = "expired-code" | "used-code" | "invalid-code";

export interface ScriptedEnvironment {
  readonly name: string;
  /** How this terminal reaches it: `local` through the grant file, `paired` before the first frame, `unpaired` only by `/pair`. */
  readonly reach: "local" | "paired" | "unpaired";
  /** Preset: a fresh UUID. Name one to start again on the same environment. */
  readonly environmentId?: string;
  readonly protocolVersion?: number;
  readonly capabilities?: CapabilityFlags;
  /** The scopes `hello` gives this terminal's client session: preset every scope. */
  readonly scopes?: readonly Scope[];
  /** What discovery answers at first: preset `ready`. */
  readonly discovery?: ScriptedDiscovery;
  readonly sessions?: readonly Partial<SessionSummary>[];
  readonly groups?: readonly Partial<Group>[];
  /** What `access.sessions.list` lists besides this terminal's own client session. */
  readonly clientSessions?: readonly Partial<ClientSessionRow>[];
  /**
   * How each method named is answered: preset accepted. A command's
   * rejection is its receipt; a query's (`access.sessions.list`) is an
   * error response with the reason as its code.
   */
  readonly receipts?: Readonly<Record<string, ScriptedReceipt>>;
  /** How the pairing exchange answers: preset it accepts any code. */
  readonly pairing?: ScriptedPairingRefusal;
  /** What `hello` says differently from discovery: another environment id, other scopes. */
  readonly hello?: Partial<HelloFrame>;
  /** Whether a socket is answered with `hello` as soon as its `auth` arrives: preset true. */
  readonly autoAccept?: boolean;
}

export interface Script {
  readonly environments: readonly ScriptedEnvironment[];
}

export interface EnvironmentHandle {
  readonly name: string;
  readonly environmentId: string;
  readonly wire: FakeWire;
  /** The environment's side of the socket the client opened last. */
  readonly server: FakeServer;
  /** What discovery answers from now on. */
  discovery(answer: ScriptedDiscovery | Partial<DiscoveryDocument>): void;
  /** What discovery answers now, as the local service's readiness reads it. */
  readiness(): ScriptedDiscovery;
  /** Says `bye` on the latest socket and closes it. */
  bye(reason: ByeReason, fields?: { readonly protocolVersion?: number; readonly message?: string }): void;
  /** Answers `hello` on the latest socket, for an environment that does not accept on its own. */
  accept(overrides?: Partial<HelloFrame>): Promise<void>;
  /** Stops or restarts answering `auth` on its own. */
  autoAccept(on: boolean): void;
  /** The requests the client sent on its latest socket, by method. */
  requests(method?: string): readonly Extract<Frame, { readonly type: "request" }>[];
}

export interface ScriptedWorld {
  readonly environments: readonly EnvironmentHandle[];
  /** Routes to each environment by its origin; nothing else answers. */
  readonly fetch: HttpFetch;
  readonly webSocket: WebSocketFactory;
  /** The local environment's grant reader; undefined when the script has none. */
  readonly grant: GrantReader | undefined;
  environment(name: string): EnvironmentHandle;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";

/** A fixture checked against the contracts' schema, so a script never feeds the runtime what no environment would send. */
const checked = <T,>(schema: { parse(value: unknown): T }, value: T): T => schema.parse(value);

const summaryOf = (clock: ManualClock, partial: Partial<SessionSummary>, index: number): SessionSummary => {
  const at = clock.now().toISOString();
  return checked(SessionSummary, {
    id: `0199aa00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: null,
    title: "New session",
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
    workspace: { kind: "directory", path: "/home/seth/code" },
    repositoryIdentity: null,
    activity: { state: "idle", since: at },
    parkedPromptCount: 0,
    accountId: null,
    model: null,
    mode: null,
    pullRequests: [],
    draft: null,
    ...partial,
  });
};

const groupOf = (clock: ManualClock, partial: Partial<Group>, index: number): Group => {
  const at = clock.now().toISOString();
  return checked(Group, {
    id: `0199bb00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Group ${index + 1}`,
    orderKey: null,
    createdAt: at,
    updatedAt: at,
    ...partial,
  });
};

/** A client session row's schema: contracts exports none by name, so it is read off `access.sessions.list`'s result. */
const ClientSessionRowSchema = registry["access.sessions.list"].result.shape.sessions.element;

const clientSessionOf = (clock: ManualClock, partial: Partial<ClientSessionRow>, index: number): ClientSessionRow => {
  const at = clock.now().toISOString();
  return checked(ClientSessionRowSchema, {
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

const PAIRING_REFUSALS: Readonly<Record<ScriptedPairingRefusal, { readonly status: number; readonly code: string }>> = {
  "expired-code": { status: 410, code: "pairing_expired" },
  "used-code": { status: 410, code: "pairing_used" },
  "invalid-code": { status: 401, code: "pairing_invalid" },
};

const later = (step: () => void) => void Promise.resolve().then(step);

const scripted = (clock: ManualClock, spec: ScriptedEnvironment, index: number) => {
  const host = `${slug(spec.name)}.test`;
  const wire = fakeWire({
    clock,
    name: spec.name,
    address: { host, port: 7433 + index },
    ...(spec.environmentId !== undefined && { environmentId: spec.environmentId }),
    ...(spec.protocolVersion !== undefined && { protocolVersion: spec.protocolVersion }),
    ...(spec.capabilities !== undefined && { capabilities: spec.capabilities }),
  });
  let discovery: ScriptedDiscovery = spec.discovery ?? "ready";
  let accepting = spec.autoAccept ?? true;
  const hello: Partial<HelloFrame> = { ...(spec.scopes && { scopes: [...spec.scopes] }), ...spec.hello };
  const setDiscovery = (answer: ScriptedDiscovery | Partial<DiscoveryDocument>) => {
    if (typeof answer === "string") {
      discovery = answer;
      wire.discovery(answer === "nothing" ? "unreachable" : { readiness: answer });
    } else {
      discovery = answer.readiness === "starting" ? "starting" : "ready";
      wire.discovery(answer);
    }
  };
  setDiscovery(discovery);

  const sessions = (spec.sessions ?? []).map((s, i) => summaryOf(clock, s, i));
  const groups = (spec.groups ?? []).map((g, i) => groupOf(clock, g, i));
  let sequence = 100;
  wire.answer("sessions.list", () => ({ result: { sequence, sessions } }));
  wire.answer("groups.list", () => ({ result: { groups } }));
  wire.answer("sessions.get", (params) => {
    const found = sessions.find((s) => s.id === params["sessionId"]);
    return found ? { result: { summary: found } } : { error: { code: "not_found", message: "No such session.", data: {} } };
  });

  const others = (spec.clientSessions ?? []).map((c, i) => clientSessionOf(clock, c, i));
  const revoked = new Set<string>();
  wire.answer("access.sessions.list", (params) => {
    const refusal = spec.receipts?.["access.sessions.list"];
    if (refusal !== undefined && refusal !== "accepted") {
      return { error: { code: refusal.rejected, message: refusal.message ?? `Rejected: ${refusal.rejected}.`, data: {} } };
    }
    const own = wire.credential();
    const listed: ClientSessionRow[] = [
      ...others,
      ...(own ? [clientSessionOf(clock, { id: own.clientSessionId, kind: "tui", label: "seth@desk:pts/3", local: spec.reach === "local" }, others.length)] : []),
    ].map((c) => (revoked.has(c.id) ? { ...c, revokedAt: clock.now().toISOString() } : c));
    return { result: { sessions: params["live"] === true ? listed.filter((c) => c.revokedAt === null) : listed } };
  });

  const receiptFor = (method: string): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method] ?? "accepted";
    if (scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    return {
      result: {
        receipt: {
          status: "rejected",
          sequence: ++sequence,
          changed: false,
          reason: scriptedReceipt.rejected,
          error: { code: scriptedReceipt.rejected, message, data: {} },
        },
      },
    };
  };
  const accepted = (result: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result },
  });
  wire.answer("access.sessions.revoke", (params) => {
    const refusal = receiptFor("access.sessions.revoke");
    if (refusal) return refusal;
    revoked.add(String(params["clientSessionId"]));
    return accepted({ revokedAt: clock.now().toISOString() });
  });
  let pairings = 0;
  wire.answer("access.pairings.create", () => {
    const refusal = receiptFor("access.pairings.create");
    if (refusal) return refusal;
    pairings++;
    const code = `K7Q2MXH4R${"TVWXYZ"[pairings % 6]}`;
    return accepted({
      pairingId: `0199dd00-0000-7000-8000-${String(pairings).padStart(12, "0")}`,
      code,
      link: `${wire.origin}/pair#${code}`,
      expiresAt: new Date(clock.now().getTime() + 10 * 60 * 1000).toISOString(),
      scopes: [...SCOPES],
      ceiling: Ceiling.parse("bypassPermissions"),
    });
  });
  // Every other scripted command, `access.*` ones included, answers its receipt alone, as a retry answered from a stored receipt does.
  const ownResponders = new Set(["access.sessions.list", "access.sessions.revoke", "access.pairings.create"]);
  for (const method of Object.keys(spec.receipts ?? {})) {
    if (ownResponders.has(method)) continue;
    wire.answer(method, () => receiptFor(method) ?? { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true } } });
  }

  const fetch: HttpFetch = async (url, request) => {
    if (spec.pairing && url === `${wire.origin}${PAIR_PATH}` && request?.method === "POST" && discovery !== "nothing") {
      const refusal = PAIRING_REFUSALS[spec.pairing];
      const body = { code: refusal.code, message: `Refused: ${refusal.code}.`, data: {} };
      return { status: refusal.status, json: async () => body };
    }
    return wire.fetch(url, request);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    const socket = wire.webSocket(url, handlers);
    return {
      send(text) {
        socket.send(text);
        if (!accepting || (JSON.parse(text) as Frame).type !== "auth") return;
        later(() => {
          try {
            wire.server.hello(hello);
          } catch {
            // The socket closed before the answer: nothing to say it on.
          }
        });
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };

  const handle: EnvironmentHandle = {
    name: spec.name,
    environmentId: wire.environmentId,
    wire,
    server: wire.server,
    discovery: setDiscovery,
    readiness: () => discovery,
    bye: (reason, fields) => wire.server.bye(reason, fields),
    accept: async (overrides) => void (await wire.server.accept({ ...hello, ...overrides })),
    autoAccept(on) {
      accepting = on;
    },
    requests: (method) =>
      wire.server
        .received()
        .filter((f): f is Extract<Frame, { readonly type: "request" }> => f.type === "request" && (method === undefined || f.method === method)),
  };
  return { handle, fetch, webSocket, wsUrl: `${wire.origin.replace(/^http/, "ws")}${WIRE_PATH}` };
};

/** Builds the script's environments on `clock`, with one `fetch` and one WebSocket factory routing to them by address. */
export const scriptedWorld = (clock: ManualClock, script: Script): ScriptedWorld => {
  const built = script.environments.map((spec, index) => scripted(clock, spec, index));
  const byName = new Map(built.map((b) => [b.handle.name, b.handle]));
  const local = script.environments.findIndex((spec) => spec.reach === "local");
  if (script.environments.filter((spec) => spec.reach === "local").length > 1) throw new Error("A script has at most one local environment.");
  return {
    environments: built.map((b) => b.handle),
    fetch: async (url, request) => {
      const target = built.find((b) => url.startsWith(`${b.handle.wire.origin}/`));
      if (!target) throw new TypeError("fetch failed");
      return target.fetch(url, request);
    },
    webSocket: (url, handlers) => {
      const target = built.find((b) => b.wsUrl === url);
      if (target) return target.webSocket(url, handlers);
      later(() => handlers.onClose(1006, "Nothing answered."));
      return { send: () => undefined, close: () => undefined };
    },
    grant: local === -1 ? undefined : (built[local] as (typeof built)[number]).handle.wire.grant,
    environment(name) {
      const found = byName.get(name);
      if (!found) throw new Error(`The script has no environment named ${name}.`);
      return found;
    },
  };
};

/** The discovery path, for a test that reads it through the world's `fetch`. */
export { DISCOVERY_PATH };
