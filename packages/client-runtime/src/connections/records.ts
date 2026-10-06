import {
  Ceiling,
  EnvironmentColour,
  EnvironmentIcon,
  EnvironmentId,
  ScopeSet,
  Timestamp,
  type ByeReason,
  type CapabilityFlags,
  type Scope,
  type PendingUpdate,
} from "@agent-harness/contracts";
import type { ConnectionAction } from "./state-machine.js";

/**
 * The connection record and the client-local documents the registry keeps
 * (docs/specs/client-runtime.md, "The connection registry"). A connection is
 * keyed by environment id. A `paired` one is saved in the `connections.paired`
 * document, its token in secret storage named by the environment id. A
 * `local` one is derived from the bootstrap grant on every start and its
 * record and token are never written down; only the local environment's
 * identity (`local.environment`: its id, address and descriptor) is kept, so
 * it stays listed, as `service-down`, on a start where the grant cannot be
 * exchanged. A local environment never seen, on a first launch with nothing
 * listening, is listed under `LOCAL_PLACEHOLDER_ID` until it answers.
 */

export type ConnectionKind = "local" | "paired";

/**
 * Why a connection will not connect until something changes: a protocol
 * mismatch (either side behind), a client session revoked or expired, or an
 * address that reaches another environment.
 */
export const BLOCKED_REASONS = ["protocol-mismatch", "unsupported-client", "revoked", "expired", "credential-unavailable", "different-environment"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * The specification's connection phases ("The connection state machine and
 * reconnect"), which the connection state machine (`state-machine.ts`)
 * moves through: `disabled`; `service-down` (the local environment: no
 * grant, or nothing answers; retried on the ladder, and offering
 * `service.start`); `starting` (discovery says so; polled every two seconds);
 * `draining` and `updating` (from `bye`, or discovery saying draining; polled
 * on the ladder until discovery says ready); `connecting` (discovery read,
 * then `auth` sent and `hello` awaited); `ready` (the socket and `hello` are
 * good, nothing more); `backoff` (a failure a retry may cure, with
 * `retryAt`, or parked while offline); and `blocked`. `syncing` is the
 * subscriptions' (#127).
 */
export type ConnectionPhase =
  | "disabled"
  | "service-down"
  | "starting"
  | "connecting"
  | "syncing"
  | "ready"
  | "backoff"
  | "blocked"
  | "draining"
  | "updating";

/**
 * What the client last learned about the environment: from discovery and
 * `hello`, and its name, icon and colour from its own stream's snapshot and
 * notices too (#323). Kept through a block.
 */
export interface EnvironmentDescriptor {
  readonly name: string;
  /** Null for an environment from before icons, which sends none. */
  readonly icon: EnvironmentIcon | null;
  /** A name, never a literal: a renderer paints it with its own token for the name. Null for an environment from before colours. */
  readonly colour: EnvironmentColour | null;
  /** From the discovery document; `hello` does not carry it. */
  readonly harnessVersion: string | null;
  readonly protocolVersion: number | null;
  readonly capabilities: CapabilityFlags;
  /** When `hello` last arrived. */
  readonly lastSeen: string | null;
}

/** What a connection holds that outlives a socket: what a `paired` one saves. */
export interface SavedConnection {
  readonly address: string;
  readonly kind: ConnectionKind;
  readonly clientSessionId: string | null;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling | null;
  readonly descriptor: EnvironmentDescriptor;
  readonly blocked: BlockedReason | null;
  /** When the client session's token expires, from the exchange that made it or the last refresh; null when not known. */
  readonly expiresAt: string | null;
}

/**
 * What became of a client session this client gave up, on removal or a
 * re-pair in place: revoked, or forgotten here and still live there because
 * the connection lacks the `admin` scope or the environment could not be reached.
 */
export type RemoveResult =
  | { readonly revoked: true }
  | { readonly revoked: false; readonly reason: "scope" | "unreachable"; readonly message: string };

/**
 * What a caller outside the socket authenticates with as this client on the
 * environment's HTTP routes (the completions surface, ADR 0015): the
 * connection's address and its client session's token as the connection
 * holds it. Never written anywhere new: a local connection's token is the
 * grant exchange's, in memory; a paired one's is in secret storage.
 */
export interface ConnectionCredential {
  /** The connection's address, the origin its routes answer at. */
  readonly origin: string;
  readonly token: string;
}

/** Progress read outside the wire while an accepted update crosses a protocol gap. */
export interface ConnectionUpdate {
  readonly pending: PendingUpdate | null;
  readonly error: string | null;
  readonly restarting: boolean;
  readonly canUpdateNow: boolean;
}

/** The update a local environment's start waits on macOS for (#1689): its version, and since when the prompt for its stored key has waited. */
export interface CredentialPrompt {
  readonly toVersion: string;
  readonly since: string;
}

/** A connection as `connections.list` shows it. */
export interface ConnectionRecord extends SavedConnection {
  readonly update?: ConnectionUpdate;
  /** Present while the local environment's start waits on the person to let it read its stored key. */
  readonly credentialPrompt?: CredentialPrompt;
  readonly environmentId: string;
  readonly enabled: boolean;
  readonly phase: ConnectionPhase;
  /** The reason of the last `bye` the environment said on this connection, until the next `hello`. */
  readonly bye: ByeReason | null;
  /** When the next attempt is due (`backoff`, and the polls of `starting`, `draining`, `updating` and `service-down`); null when none is scheduled, as while offline. */
  readonly retryAt: string | null;
  /** Since when the environment has not been reached: the first failure after `ready`, or the start when there is cached data. Null once ready. */
  readonly unreachableSince: string | null;
  /** Why the last token refresh failed, until one succeeds; the socket stays up either way. */
  readonly refreshFailed: string | null;
  /** What David can do about where the connection is: start the local service, re-pair, or update one side. */
  readonly action: ConnectionAction | null;
}

/**
 * The runtime's client-local preferences, one document per key: the fixed
 * key schema the ADR 0003 lint inspects, so no key is named after a session
 * field. The ordered environment list is `environments.sequence`, since the
 * lint's word list holds `order`.
 */
export interface ClientPreferences {
  /** Environment ids in David's order; the first known one is the primary environment, which orders merged groups. */
  readonly "environments.sequence": readonly string[];
  /** An environment set to false is disabled; one not named is enabled. */
  readonly "environments.enabled": Readonly<Record<string, boolean>>;
  /** The environment last used, for the default-environment rule (ADR 0005). */
  readonly "environments.lastUsed": string | null;
  /**
   * The directories hidden from an environment's known directories on this
   * client (workspace-picker spec): by environment id, each path with its
   * last use when it was hidden, so a session using it after that brings it
   * back. Client-local presentation, one of the lint's presentation keys.
   */
  readonly hiddenDirectories: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Each preference as it is before David sets it. Its keys are the documents the preferences are stored under. */
export const NO_PREFERENCES: ClientPreferences = {
  "environments.sequence": [],
  "environments.enabled": {},
  "environments.lastUsed": null,
  hiddenDirectories: {},
};

export const PREFERENCE_KEYS = Object.keys(NO_PREFERENCES) as readonly (keyof ClientPreferences)[];

/** The document the saved `paired` connections are kept in, by environment id. */
export const PAIRED_CONNECTIONS_DOCUMENT = "connections.paired";

export const emptyDescriptor = (name: string): EnvironmentDescriptor => ({
  name,
  icon: null,
  colour: null,
  harnessVersion: null,
  protocolVersion: null,
  capabilities: [],
  lastSeen: null,
});

const isString = (value: unknown): value is string => typeof value === "string";
const stringOrNull = (value: unknown): string | null => (isString(value) ? value : null);
const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The preferences as stored, each key read on its own; a value that is not what the key holds reads as unset. */
export const readPreferences = (stored: Readonly<Record<keyof ClientPreferences, unknown>>): ClientPreferences => {
  const sequence = stored["environments.sequence"];
  const enabled = objectOf(stored["environments.enabled"]) ?? {};
  return {
    "environments.sequence": Array.isArray(sequence) ? [...new Set(sequence.filter(isString))] : [],
    "environments.enabled": Object.fromEntries(Object.entries(enabled).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")),
    "environments.lastUsed": stringOrNull(stored["environments.lastUsed"]),
    hiddenDirectories: Object.fromEntries(
      Object.entries(objectOf(stored.hiddenDirectories) ?? {}).map(([environmentId, hidden]) => [
        environmentId,
        Object.fromEntries(Object.entries(objectOf(hidden) ?? {}).filter((entry): entry is [string, string] => Timestamp.safeParse(entry[1]).success)),
      ]),
    ),
  };
};

const readDescriptor = (value: unknown): EnvironmentDescriptor | undefined => {
  const d = objectOf(value);
  if (!d || !isString(d["name"])) return undefined;
  const capabilities = d["capabilities"];
  return {
    name: d["name"],
    icon: EnvironmentIcon.safeParse(d["icon"]).data ?? null,
    colour: EnvironmentColour.safeParse(d["colour"]).data ?? null,
    harnessVersion: stringOrNull(d["harnessVersion"]),
    protocolVersion: typeof d["protocolVersion"] === "number" ? d["protocolVersion"] : null,
    capabilities: Array.isArray(capabilities) ? capabilities.filter(isString) : [],
    lastSeen: stringOrNull(d["lastSeen"]),
  };
};

/** The saved `paired` connections, by environment id; an entry that does not read as one is dropped. */
export const readPairedConnections = (stored: unknown): Map<string, SavedConnection> => {
  const out = new Map<string, SavedConnection>();
  for (const [id, value] of Object.entries(objectOf(stored) ?? {})) {
    const entry = objectOf(value);
    const descriptor = readDescriptor(entry?.["descriptor"]);
    if (!entry || !descriptor || !EnvironmentId.safeParse(id).success || !isString(entry["address"])) continue;
    const scopes = ScopeSet.safeParse(entry["scopes"]);
    const ceiling = Ceiling.safeParse(entry["ceiling"]);
    const blocked = entry["blocked"];
    const expiresAt = Timestamp.safeParse(entry["expiresAt"]);
    out.set(id, {
      address: entry["address"],
      kind: "paired",
      clientSessionId: stringOrNull(entry["clientSessionId"]),
      scopes: scopes.success ? scopes.data : [],
      ceiling: ceiling.success ? ceiling.data : null,
      descriptor,
      blocked: (BLOCKED_REASONS as readonly unknown[]).includes(blocked) ? (blocked as BlockedReason) : null,
      expiresAt: expiresAt.success ? expiresAt.data : null,
    });
  }
  return out;
};

/** The `paired` connections as they are saved: everything but the kind, which the document implies. */
export const writePairedConnections = (saved: Iterable<[string, SavedConnection]>): Record<string, unknown> =>
  Object.fromEntries(
    [...saved]
      .filter(([, connection]) => connection.kind === "paired")
      .map(([id, c]) => [
        id,
        {
          address: c.address,
          clientSessionId: c.clientSessionId,
          scopes: c.scopes,
          ceiling: c.ceiling,
          descriptor: c.descriptor,
          blocked: c.blocked,
          expiresAt: c.expiresAt,
        },
      ]),
  );

/**
 * The id the local connection is listed under before the local environment
 * has ever answered: a first launch with the grant reader finding no grant,
 * or a grant whose address answers nothing, and nothing remembered. It is
 * not an environment id (those are UUIDs), so it never meets a real one. The
 * placeholder is `service-down` with the `service.start` action and retries
 * the grant on the ladder; no request or subscription goes to it, and it is
 * never saved. The first grant exchange or discovery document that names the
 * environment replaces it with the environment's own record, in its place.
 */
export const LOCAL_PLACEHOLDER_ID = "local";

/** What the placeholder's record calls the environment in the runtime's own lines; `projections.environments` shows its name as null. */
export const LOCAL_PLACEHOLDER_NAME = "This machine's local environment";

/** The document the local environment's identity is kept in; never its token or client session. */
export const LOCAL_ENVIRONMENT_DOCUMENT = "local.environment";

/** The local environment as last seen: enough to list it while its service is down. */
export interface RememberedLocal {
  readonly environmentId: string;
  readonly address: string;
  readonly descriptor: EnvironmentDescriptor;
}

export const readRememberedLocal = (stored: unknown): RememberedLocal | undefined => {
  const entry = objectOf(stored);
  const descriptor = readDescriptor(entry?.["descriptor"]);
  const id = entry?.["environmentId"];
  if (!entry || !descriptor || !isString(id) || !EnvironmentId.safeParse(id).success || !isString(entry["address"])) return undefined;
  return { environmentId: id, address: entry["address"], descriptor };
};
