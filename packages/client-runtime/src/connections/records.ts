import { Ceiling, EnvironmentId, ScopeSet, type ByeReason, type Scope } from "@agent-harness/contracts";

/**
 * The connection record and the client-local documents the registry keeps
 * (docs/specs/client-runtime.md, "The connection registry"). A connection is
 * keyed by environment id. A `local` one is derived from the bootstrap grant
 * on every start and never written down; a `paired` one is saved in the
 * `connections.paired` document. The token is in secret storage, named by
 * the environment id, and never in a record.
 */

export type ConnectionKind = "local" | "paired";

/** Why a connection will not connect until something changes (the reconnect machine, #126, adds `revoked` and `expired` from `bye`). */
export const BLOCKED_REASONS = ["protocol-mismatch", "unsupported-client", "revoked", "expired", "different-environment"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * Where a connection is, as far as this runtime makes one attempt: `disabled`;
 * `connecting` (discovery read, `auth` sent, awaiting `hello`); `ready`;
 * `not-ready` (discovery said starting or draining); `unreachable` (nothing
 * answered); `disconnected` (a socket that was ready, or never got `hello`,
 * closed; `bye` says why when the environment said); `blocked`. The
 * reconnect machine (#126) turns these into the specification's phases
 * with backoff, the watchdog and `bye` handling.
 */
export type ConnectionPhase = "disabled" | "connecting" | "ready" | "not-ready" | "unreachable" | "disconnected" | "blocked";

/** What the client last learned about the environment: from discovery and `hello`. Kept through a block. */
export interface EnvironmentDescriptor {
  readonly name: string;
  /** From `environment.status` once the workspace-picker workstream serves it; null until then. */
  readonly icon: string | null;
  readonly colour: string | null;
  /** From the discovery document; `hello` does not carry it. */
  readonly harnessVersion: string | null;
  readonly protocolVersion: number | null;
  readonly capabilities: readonly string[];
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
}

/** A connection as `connections.list` shows it. */
export interface ConnectionRecord extends SavedConnection {
  readonly environmentId: string;
  readonly enabled: boolean;
  readonly phase: ConnectionPhase;
  /** The reason of the last `bye` the environment said on this connection, until the next `hello`. */
  readonly bye: ByeReason | null;
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
}

export const PREFERENCE_KEYS = ["environments.sequence", "environments.enabled", "environments.lastUsed"] as const satisfies readonly (keyof ClientPreferences)[];

export const NO_PREFERENCES: ClientPreferences = {
  "environments.sequence": [],
  "environments.enabled": {},
  "environments.lastUsed": null,
};

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
export const readPreferences = (stored: { readonly [K in keyof ClientPreferences]: unknown }): ClientPreferences => {
  const sequence = stored["environments.sequence"];
  const enabled = objectOf(stored["environments.enabled"]) ?? {};
  return {
    "environments.sequence": Array.isArray(sequence) ? [...new Set(sequence.filter(isString))] : [],
    "environments.enabled": Object.fromEntries(Object.entries(enabled).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")),
    "environments.lastUsed": stringOrNull(stored["environments.lastUsed"]),
  };
};

const readDescriptor = (value: unknown): EnvironmentDescriptor | undefined => {
  const d = objectOf(value);
  if (!d || !isString(d["name"])) return undefined;
  const capabilities = d["capabilities"];
  return {
    name: d["name"],
    icon: stringOrNull(d["icon"]),
    colour: stringOrNull(d["colour"]),
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
    out.set(id, {
      address: entry["address"],
      kind: "paired",
      clientSessionId: stringOrNull(entry["clientSessionId"]),
      scopes: scopes.success ? scopes.data : [],
      ceiling: ceiling.success ? ceiling.data : null,
      descriptor,
      blocked: (BLOCKED_REASONS as readonly unknown[]).includes(blocked) ? (blocked as BlockedReason) : null,
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
        { address: c.address, clientSessionId: c.clientSessionId, scopes: c.scopes, ceiling: c.ceiling, descriptor: c.descriptor, blocked: c.blocked },
      ]),
  );
