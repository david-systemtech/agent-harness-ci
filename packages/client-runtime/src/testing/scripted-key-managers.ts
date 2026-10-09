import {
  KEY_MANAGER_EVENT_PAYLOADS,
  KEY_MANAGER_MOVE_EVENT_PAYLOADS,
  KeyManagerCertificate,
  KeyManagerConnectionRecord,
  MANAGED_TOOLS,
  ManagedToolRow,
  httpOriginOf,
  invalidParams,
  keyManagerCliRow,
  type KeyManagerCredential,
  type KeyManagerLoginPolicy,
  type KeyManagerMoveItemResult,
  type KeyManagerProvider,
  type KeyManagerReference,
  type KeyManagerStatus,
} from "@agent-harness/contracts";
import { uuidv4 } from "../ids.js";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's key managers (key-managers spec, "Wire
 * methods", "Move stored tokens" and "Copies and the state import"; ADR
 * 0028; #425): the connections `keyManagers.list` answers and the commands
 * that change them, answered as the environment's registry answers them
 * over a key manager the script describes, and each change appended as its
 * `key-manager.*` event on the environment stream, so a client's request
 * cache reads the list again and its notices hear the statuses. The key
 * manager is one OpenBao for every address: it refuses the secrets the
 * script names, and its certificate at an address the script calls
 * untrusted verifies only against the anchor `certificateOf` answers, which
 * `keyManagers.certificate.preview` reads. Move writes into one store of
 * values by path, which a person's own paste (`pasteKeyManagerValue`) writes
 * into too. A test changes what a verification finds (`setKeyManagerStatus`),
 * has the environment's own verification find it (`verifyKeyManager`), and
 * holds the list's answers (`holdKeyManagerLists`).
 */

/** A forge account holding a stored token, as Move lists it. */
export interface ScriptedMoveItem {
  /** Its id; preset a fresh one. */
  readonly id?: string;
  /** What people know it by: the forge account's origin. */
  readonly name: string;
  /** The forge account's slug, which its target is named by (`<base>/forge-<slug>`). */
  readonly slug: string;
  /** The stored token: preset `stored-token-for-tests-<slug>`. */
  readonly value?: string;
}

export interface ScriptedKeyManagers {
  /** The connections held from the start, each over an OpenBao at `https://bao-<n>.test:8200` signed in by AppRole, the first injecting; the fields given replace its own. */
  readonly connections?: readonly Partial<KeyManagerConnectionRecord>[];
  /** The policies a sign-in's login holds, with their write flags: preset `default` and `agent-read`, neither writing. */
  readonly policies?: readonly KeyManagerLoginPolicy[];
  /** The secrets the key manager refuses: an AppRole secret id, a password or a token among them is `verification_failed` reason `rejected`. */
  readonly rejects?: readonly string[];
  /** The origins whose certificate the environment does not trust: a connection there signs in only with `certificateOf(origin)` pinned. */
  readonly untrusted?: readonly string[];
  /** The addresses that do not answer: an add signing in to one is saved standing `unreachable`, as the environment saves it (#1851). */
  readonly unreachable?: readonly string[];
  /** The base path a login suggests while none is set: preset `personal/harness`. */
  readonly suggestedBasePath?: string | null;
  /** The forge accounts holding a stored token, as `keyManagers.move.list` lists them. */
  readonly items?: readonly ScriptedMoveItem[];
  /** Whether a login may write a Move's targets: preset true; false answers every write `cannot_write`. */
  readonly writable?: boolean;
  /** The values the key manager holds already, by path under the mount (`personal/harness/forge-github`), each at the key `token`. */
  readonly values?: Readonly<Record<string, string>>;
  /** The rows `tools.list` answers (`scripted-tools.ts`), each over its tool installed by apt at 2.1.1, current. */
  readonly tools?: readonly (Partial<ManagedToolRow> & Pick<ManagedToolRow, "tool">)[];
}

export interface ScriptedKeyManagersHandle {
  /** The connections as the environment holds them now. */
  keyManagerConnections(): readonly KeyManagerConnectionRecord[];
  /** The value the key manager holds at a path under its mount (`personal/harness/forge-github`); undefined for none. */
  keyManagerValue(path: string): string | undefined;
  /** A person writes `value` at a path in the key manager themselves, as a paste after Copy value does. */
  pasteKeyManagerValue(path: string, value: string): void;
  /** What the next verification of the connection finds, over what it holds now; nothing is said until one runs. */
  setKeyManagerStatus(connectionId: string, status: Pick<KeyManagerStatus, "kind" | "message">): void;
  /** The environment's own verification of the connection runs now, and records what it finds. */
  verifyKeyManager(connectionId: string): void;
  /** Holds every `keyManagers.list` unanswered until the function it returns is called, each then answered as the environment stands at the release. */
  holdKeyManagerLists(): () => void;
}

export interface KeyManagersHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  readonly script: ScriptedKeyManagers | undefined;
  /** Says an event on the environment's own stream, as the environment appends it. */
  notice(type: string, payload: Record<string, unknown>): void;
  /** The stream's head now, which an accepted receipt names. */
  head(): number;
  /** Takes the next sequence, for a rejected receipt. */
  next(): number;
  /** A rejection the script names for `method`, if any. */
  refusal(method: string): FakeAnswer | undefined;
  /** The managed tools' rows as the environment holds them now (`scripted-tools.ts`). */
  toolRows(): readonly ManagedToolRow[];
}

/** What each provider is called in a line. */
const PROVIDER_NAMES: Readonly<Record<KeyManagerProvider, string>> = { openbao: "OpenBao", doppler: "Doppler", onepassword: "1Password", bitwarden: "Bitwarden Secrets Manager" };

/** The variables an injecting OpenBao connection's block names, as `keyManagers.list` answers them. */
const OPENBAO_VARIABLES = ["BAO_ADDR", "BAO_TOKEN", "BAO_CACERT_BYTES", "VAULT_ADDR", "VAULT_TOKEN", "VAULT_CACERT_BYTES"];

const PRESET_POLICIES: readonly KeyManagerLoginPolicy[] = [
  { name: "default", writes: "no" },
  { name: "agent-read", writes: "no" },
];

/** Two hex digits for each of 32 bytes read off `text`, as a fingerprint's shape asks. */
const fingerprintOf = (text: string): string =>
  Array.from({ length: 32 }, (_, at) => ((text.charCodeAt(at % text.length) * (at + 7)) % 256).toString(16).toUpperCase().padStart(2, "0")).join(":");

/** The anchor of the chain the key manager at `origin` presents: a self-signed CA named for its host, PEM in shape only. */
export const certificateOf = (origin: string): KeyManagerCertificate => {
  const host = origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  return KeyManagerCertificate.parse({
    pem: `-----BEGIN CERTIFICATE-----\nanchor-for-${host}\n-----END CERTIFICATE-----\n`,
    sha256Fingerprint: fingerprintOf(host),
    subject: `CN=${host} test CA`,
    names: [host],
    expiresAt: "2027-09-24T00:00:00.000Z",
    selfSigned: true,
  });
};

/** A secret the credential carries, which the key manager refuses or not. */
const secretOf = (credential: KeyManagerCredential): string => {
  switch (credential.method) {
    case "approle":
      return credential.secretId;
    case "userpass":
      return credential.password;
    case "token":
      return credential.token;
  }
};

/** The key-manager commands this module answers, which a script's receipts never answer in its place. */
export const KEY_MANAGER_COMMANDS: readonly string[] = [
  "keyManagers.connections.add",
  "keyManagers.connections.signIn",
  "keyManagers.connections.update",
  "keyManagers.connections.signOut",
  "keyManagers.connections.remove",
  "keyManagers.connections.setPolicies",
  "keyManagers.connections.setInjected",
  "keyManagers.connections.setBasePath",
  "keyManagers.move",
  "keyManagers.move.copyValue",
];

export const scriptedKeyManagers = (host: KeyManagersHost): ScriptedKeyManagersHandle => {
  const { clock, wire } = host;
  const script = host.script ?? {};
  const now = () => clock.now().toISOString();
  const status = (kind: KeyManagerStatus["kind"], message: string): KeyManagerStatus => ({ kind, since: now(), message });
  const policies = script.policies ?? PRESET_POLICIES;
  const untrusted = new Set(script.untrusted ?? []);

  const suggested = script.suggestedBasePath === undefined ? "personal/harness" : script.suggestedBasePath;
  /** The base path a login suggests for a connection while it has none set, as each verification reads it. */
  const suggestionFor = (basePath: string | null): string | null => (basePath === null ? suggested : null);

  const signedIn = (method: string | null): Pick<KeyManagerConnectionRecord, "status" | "tokenInformation" | "policies" | "canMint" | "verifiedAt"> => ({
    status: status("signed-in", `Signed in to OpenBao as ${method ?? "token"}.`),
    tokenInformation: { displayName: method ?? "token", policies: policies.map((policy) => policy.name), ttlSeconds: 3600, renewable: true, expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString() },
    policies: [...policies],
    canMint: true,
    verifiedAt: now(),
  });

  const connections: KeyManagerConnectionRecord[] = (script.connections ?? []).map((fields, index) =>
    KeyManagerConnectionRecord.parse({
      id: uuidv4(),
      provider: "openbao",
      label: "OpenBao",
      address: `https://bao-${index + 1}.test:8200`,
      ca: null,
      method: "approle",
      mount: "approle",
      username: null,
      tokenRole: null,
      ticks: policies.map((policy) => policy.name),
      basePath: null,
      suggestedBasePath: suggestionFor(fields.basePath ?? null),
      injects: index === 0,
      injectedVariables: index === 0 ? OPENBAO_VARIABLES : [],
      ...signedIn("approle"),
      copiedFrom: null,
      importedFrom: null,
      createdAt: now(),
      ...fields,
    }),
  );
  /** The credential each connection keeps, by its id: the ones held from the start keep one the key manager takes. */
  const credentials = new Map<string, KeyManagerCredential>(
    connections.filter((c) => c.status.kind !== "awaiting-sign-in").map((c) => [c.id, { method: "approle", roleId: "role-for-tests", secretId: "secret-for-tests" }]),
  );
  /** What the next verification finds, by connection id. */
  const pending = new Map<string, Pick<KeyManagerStatus, "kind" | "message">>();
  const values = new Map<string, string>(Object.entries(script.values ?? {}));
  const items = (script.items ?? []).map((item) => ({ ...item, id: item.id ?? uuidv4(), value: item.value ?? `stored-token-for-tests-${item.slug}` }));
  /** The items a Move answered `cannot_write` for, each offered once to Copy value: `<connection id> <item id>`. */
  const offered = new Set<string>();
  /** The connection each moved item's reference names, by item id. */
  const referenced = new Map<string, { readonly connectionId: string; readonly name: string }>();

  const find = (id: unknown) => connections.find((c) => c.id === String(id).toLowerCase());
  const put = (record: KeyManagerConnectionRecord) => {
    const at = connections.findIndex((c) => c.id === record.id);
    connections[at] = KeyManagerConnectionRecord.parse(record);
  };
  const event = (type: keyof typeof KEY_MANAGER_EVENT_PAYLOADS | keyof typeof KEY_MANAGER_MOVE_EVENT_PAYLOADS, payload: Record<string, unknown>) =>
    host.notice(type, ({ ...KEY_MANAGER_EVENT_PAYLOADS, ...KEY_MANAGER_MOVE_EVENT_PAYLOADS }[type].parse(payload) as Record<string, unknown>));
  const accepted = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: host.head(), changed: true }, result } });
  const rejected = (code: string, message: string, data: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: host.next(), changed: false, reason: code, error: { code, message, data } } },
  });
  const notFound = (id: unknown): FakeAnswer => rejected("not_found", `No key-manager connection ${String(id)} is on this environment.`, { kind: "key_manager_connection" });
  const invalid = (path: string, message: string): FakeAnswer => ({ error: invalidParams([{ code: "custom", path: [path], message }], message) });
  /** A provider this version's environment cannot sign in to or move into yet (#377 to #379), as it refuses one: a sign-in in setup-copy.md §5.7's words, what was met in details (#1852). */
  const unavailable = (provider: KeyManagerProvider, what: string, after: string): FakeAnswer =>
    what === "sign in to"
      ? rejected("provider_unavailable", `agent-harness cannot connect to ${PROVIDER_NAMES[provider]} on this computer yet.`, {
          provider,
          details: [`No ${PROVIDER_NAMES[provider]} provider is loaded on this environment.`, after.trim()],
        })
      : rejected("provider_unavailable", `This environment cannot ${what} ${PROVIDER_NAMES[provider]} yet.${after}`, { provider });

  /** How a sign-in with `credential` against `address` pinning `ca` goes: signed in, refused, or held back by a certificate the environment does not trust. */
  const tryCredential = (address: string, ca: string | null, credential: KeyManagerCredential, connectionId: string): "signed-in" | "untrusted" | "unreachable" | FakeAnswer => {
    if ((script.unreachable ?? []).includes(address)) return "unreachable";
    if ((script.rejects ?? []).includes(secretOf(credential))) {
      return rejected("verification_failed", "OpenBao did not accept these details. Check them and try again.", {
        connectionId,
        reason: "rejected",
        details: [`OpenBao at ${address} refused the credential (HTTP 400: invalid role or secret ID).`, "Nothing was stored."],
      });
    }
    return untrusted.has(address) && ca !== certificateOf(address).pem ? "untrusted" : "signed-in";
  };
  const untrustedStatus = (address: string) =>
    status("certificate-rejected", `OpenBao at ${address} presented a certificate the system's trusted CAs do not verify: check it and pin its CA in Set up, Key manager.`);
  /** Whether no other connection of the provider injects, so this one, signed in now, does. */
  const firstOfProvider = (record: KeyManagerConnectionRecord) => !connections.some((c) => c.id !== record.id && c.provider === record.provider && c.injects);

  /** Every managed tool's row as the environment holds it now: the one held, else not installed. */
  const everyTool = () =>
    MANAGED_TOOLS.map(
      ({ name, label, minimum }) =>
        host.toolRows().find((row) => row.tool === name) ??
        ManagedToolRow.parse({ tool: name, label, path: null, realpath: null, version: null, latest: null, minimum, method: null, status: "not-installed", action: "install", command: null }),
    );

  let heldLists: (() => void)[] | null = null;
  wire.answer("keyManagers.list", (): FakeAnswer | Promise<FakeAnswer> => {
    // Each with its CLI's Managed tools row (#375).
    const answer = (): FakeAnswer => ({ result: { connections: connections.map((record) => ({ ...record, cli: keyManagerCliRow(record.provider, everyTool()) })) } });
    const waiting = heldLists;
    return waiting === null ? answer() : new Promise((resolve) => waiting.push(() => resolve(answer())));
  });

  wire.answer("keyManagers.connections.add", (params) => {
    const refused = host.refusal("keyManagers.connections.add");
    if (refused) return refused;
    const id = String(params["connectionId"]);
    // A 1Password add with a token gives no address: the environment learns the account URL the token names as it signs in (#378), which this fake does not,
    // answering it as it answers a credential for any provider but OpenBao.
    if (params["provider"] === "onepassword" && params["credential"] !== undefined && params["address"] === undefined) return unavailable("onepassword", "sign in to", " Nothing was stored.");
    const address = httpOriginOf(String(params["address"]));
    if (address === null) return invalid("address", `${String(params["address"])} is not an http or https origin.`);
    const provider = params["provider"] as KeyManagerProvider;
    if (connections.some((c) => c.provider === provider && c.address === address)) {
      return rejected("conflict", `A connection to ${PROVIDER_NAMES[provider]} at ${address} is on this environment already.`, { reason: "connection_exists" });
    }
    const credential = params["credential"] as KeyManagerCredential | undefined;
    // As this version's environment does: it signs in to OpenBao alone, and adds another provider only without a credential (#365).
    if (credential !== undefined && provider !== "openbao") return unavailable(provider, "sign in to", " Nothing was stored.");
    const method = (params["method"] as KeyManagerCredential["method"] | undefined) ?? credential?.method ?? null;
    const ca = (params["ca"] as string | undefined) ?? null;
    const tried = credential === undefined ? "none" : tryCredential(address, ca, credential, id);
    if (typeof tried === "object") return tried;
    const base: KeyManagerConnectionRecord = KeyManagerConnectionRecord.parse({
      id,
      provider,
      label: params["label"],
      address,
      ca,
      method: provider === "openbao" ? method : null,
      mount: provider === "openbao" ? ((params["mount"] as string | undefined) ?? (method === null ? null : method)) : null,
      username: (params["username"] as string | undefined) ?? null,
      tokenRole: (params["tokenRole"] as string | undefined) ?? null,
      policies: null,
      ticks: (params["ticks"] as string[] | undefined) ?? null,
      basePath: (params["basePath"] as string | undefined) ?? null,
      suggestedBasePath: null,
      injects: false,
      injectedVariables: [],
      status: status("awaiting-sign-in", "No credential is on this environment: sign in in Set up, Key manager."),
      tokenInformation: null,
      canMint: null,
      verifiedAt: null,
      copiedFrom: params["copiedFrom"] ?? null,
      importedFrom: params["importedFrom"] ?? null,
      createdAt: now(),
    });
    let record = base;
    if (tried === "untrusted") record = { ...base, status: untrustedStatus(address) };
    if (tried === "unreachable") record = { ...base, status: status("unreachable", `OpenBao at ${address} could not be reached: connect ECONNREFUSED.`) };
    if (tried === "signed-in") {
      const injects = firstOfProvider(base);
      record = {
        ...base,
        ...signedIn(method),
        ticks: base.ticks ?? policies.map((policy) => policy.name),
        suggestedBasePath: suggestionFor(base.basePath),
        injects,
        injectedVariables: injects ? OPENBAO_VARIABLES : [],
      };
    }
    connections.push(KeyManagerConnectionRecord.parse(record));
    if (credential !== undefined) credentials.set(id, credential);
    event("key-manager.connection.added", {
      connectionId: id,
      ...Object.fromEntries(
        (["provider", "label", "address", "ca", "method", "mount", "username", "tokenRole", "ticks", "basePath", "injects", "status", "tokenInformation", "copiedFrom", "importedFrom"] as const).map((key) => [key, record[key]]),
      ),
      credential: credential === undefined ? null : `key-manager:${id}:${uuidv4()}`,
    });
    return accepted({ connection: record });
  });

  /** Signs the connection in with `credential` at the address and CA it would hold, as signIn and update do; the refusal, or the record signed in. */
  const signInWith = (record: KeyManagerConnectionRecord, credential: KeyManagerCredential, changes: Partial<KeyManagerConnectionRecord>): FakeAnswer | KeyManagerConnectionRecord => {
    const address = changes.address ?? record.address;
    const ca = changes.ca === undefined ? record.ca : changes.ca;
    const tried = tryCredential(address, ca, credential, record.id);
    if (typeof tried === "object") return tried;
    if (tried === "untrusted") return rejected("certificate_rejected", `${untrustedStatus(address).message} Nothing was changed.`, { connectionId: record.id });
    if (tried === "unreachable") {
      return rejected("unreachable", `agent-harness could not reach ${address}. Check the address.`, { connectionId: record.id, details: [`connect ECONNREFUSED at ${address}.`, "Nothing was changed."] });
    }
    const injects = record.injects || firstOfProvider(record);
    return {
      ...record,
      ...changes,
      ...signedIn(credential.method),
      ticks: record.ticks ?? policies.map((policy) => policy.name),
      suggestedBasePath: suggestionFor(record.basePath),
      injects,
      injectedVariables: injects ? OPENBAO_VARIABLES : [],
    };
  };

  wire.answer("keyManagers.connections.signIn", (params) => {
    const refused = host.refusal("keyManagers.connections.signIn");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    if (record.provider !== "openbao") return unavailable(record.provider, "sign in to", " Nothing was changed.");
    const credential = params["credential"] as KeyManagerCredential;
    const signed = signInWith(record, credential, {
      method: credential.method,
      mount: (params["mount"] as string | undefined) ?? (record.method === credential.method ? record.mount : credential.method),
      username: credential.method === "userpass" ? ((params["username"] as string | undefined) ?? record.username) : null,
    });
    if ("result" in signed || "error" in signed) return signed;
    put(signed);
    credentials.set(record.id, credential);
    event("key-manager.connection.signed-in", {
      connectionId: record.id,
      status: signed.status,
      tokenInformation: signed.tokenInformation,
      credential: `key-manager:${record.id}:${uuidv4()}`,
      ...(record.ticks === null && { ticks: signed.ticks }),
      ...(signed.injects && !record.injects && { injects: true }),
    });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.connections.update", (params) => {
    const refused = host.refusal("keyManagers.connections.update");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    const address = params["address"] === undefined ? undefined : httpOriginOf(String(params["address"]));
    if (address === null) return invalid("address", `${String(params["address"])} is not an http or https origin.`);
    const changes: Partial<KeyManagerConnectionRecord> = {
      ...(params["label"] !== undefined && params["label"] !== record.label && { label: String(params["label"]) }),
      ...(address !== undefined && address !== record.address && { address }),
      ...(params["ca"] !== undefined && params["ca"] !== record.ca && { ca: params["ca"] as string | null }),
      ...(params["tokenRole"] !== undefined && params["tokenRole"] !== record.tokenRole && { tokenRole: params["tokenRole"] as string | null }),
    };
    const credential = credentials.get(record.id);
    const signsIn = credential !== undefined && (changes.address !== undefined || changes.ca !== undefined);
    const updated = signsIn ? signInWith(record, credential, changes) : { ...record, ...changes };
    if ("result" in updated || "error" in updated) return updated;
    put(updated);
    if (Object.keys(changes).length > 0) event("key-manager.connection.updated", { connectionId: record.id, ...changes });
    if (signsIn && record.status.kind !== "signed-in") event("key-manager.connection.signed-in", { connectionId: record.id, status: updated.status, tokenInformation: updated.tokenInformation });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.connections.signOut", (params) => {
    const refused = host.refusal("keyManagers.connections.signOut");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    if (record.status.kind === "awaiting-sign-in") return accepted({ connection: record });
    const out = status("awaiting-sign-in", "Signed out: sign in again in Set up, Key manager.");
    // What the login was known by goes with it, as the environment's store drops it.
    put({ ...record, status: out, tokenInformation: null, policies: null, canMint: null, injects: false, injectedVariables: [] });
    credentials.delete(record.id);
    event("key-manager.connection.signed-out", { connectionId: record.id, status: out });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.connections.remove", (params) => {
    const refused = host.refusal("keyManagers.connections.remove");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    const holders = [...referenced.entries()].filter(([, held]) => held.connectionId === record.id).map(([id, held]) => ({ kind: "forge-account", id, name: held.name }));
    if (holders.length > 0 && params["force"] !== true) {
      const names = holders.map((holder) => holder.name).join(", ");
      return rejected("conflict", `References to ${record.label} are held by ${names}: remove it anyway and they no longer resolve.`, { reason: "referenced", connectionId: record.id, holders });
    }
    connections.splice(connections.indexOf(record), 1);
    credentials.delete(record.id);
    event("key-manager.connection.removed", { connectionId: record.id });
    return accepted({ connectionId: record.id });
  });

  /** Verifies the connection now: what a test set for it is found, and recorded when it changes the status. */
  const verify = (record: KeyManagerConnectionRecord): void => {
    const found = pending.get(record.id);
    pending.delete(record.id);
    if (record.status.kind === "awaiting-sign-in") return;
    const next: KeyManagerConnectionRecord =
      found === undefined || found.kind === record.status.kind
        ? { ...record, verifiedAt: now() }
        : found.kind === "signed-in"
          ? { ...record, ...signedIn(record.method), suggestedBasePath: suggestionFor(record.basePath) }
          : { ...record, status: status(found.kind, found.message), verifiedAt: now() };
    put(next);
    if (next.status.kind !== record.status.kind) {
      event("key-manager.connection.verified", { connectionId: record.id, status: next.status, tokenInformation: next.tokenInformation, policies: next.policies, canMint: next.canMint });
    }
  };

  wire.answer("keyManagers.connections.verify", (params) => {
    const one = params["connectionId"];
    for (const record of one === undefined ? [...connections] : [find(one)].filter((r) => r !== undefined)) verify(record);
    return { result: { connections: [...connections] } };
  });

  wire.answer("keyManagers.connections.setPolicies", (params) => {
    const refused = host.refusal("keyManagers.connections.setPolicies");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    const asked = params["ticks"] as string[];
    const held = (record.policies ?? []).map((policy) => policy.name);
    const stranger = asked.find((name) => !held.includes(name));
    if (record.policies === null || stranger !== undefined) return invalid("ticks", `The login of ${record.label} holds no policy ${stranger ?? asked[0] ?? ""}.`);
    const ticks = held.filter((name) => asked.includes(name));
    put({ ...record, ticks });
    if (JSON.stringify(ticks) !== JSON.stringify(record.ticks)) event("key-manager.connection.policies-set", { connectionId: record.id, ticks });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.connections.setInjected", (params) => {
    const refused = host.refusal("keyManagers.connections.setInjected");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    if (record.injects) return accepted({ connection: record });
    const replaced = connections.find((c) => c.provider === record.provider && c.injects);
    if (replaced !== undefined) put({ ...replaced, injects: false, injectedVariables: [] });
    // Only OpenBao's block is given by this version, so another provider's names none.
    put({ ...record, injects: true, injectedVariables: record.provider === "openbao" ? OPENBAO_VARIABLES : [] });
    event("key-manager.connection.injected-set", { connectionId: record.id, replaced: replaced?.id ?? null });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.connections.setBasePath", (params) => {
    const refused = host.refusal("keyManagers.connections.setBasePath");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    const basePath = String(params["basePath"]);
    if (record.provider === "openbao" && basePath.split("/").length !== 2) {
      return invalid("basePath", `A base path on OpenBao is a KV mount and one project segment, as personal/harness: ${basePath} is not.`);
    }
    put({ ...record, basePath, suggestedBasePath: null });
    if (basePath !== record.basePath) event("key-manager.connection.base-path-set", { connectionId: record.id, basePath });
    return accepted({ connection: find(record.id) });
  });

  wire.answer("keyManagers.certificate.preview", (params) => {
    const origin = httpOriginOf(String(params["address"]));
    if (origin === null || !origin.startsWith("https://")) return invalid("address", `${String(params["address"])} is no https origin.`);
    return { result: { certificate: certificateOf(origin) } };
  });

  /** An item's target on the connection: its reference, where the key manager keeps its value, and the path under the mount. */
  const targetOf = (record: KeyManagerConnectionRecord, item: (typeof items)[number]): { readonly reference: KeyManagerReference; readonly path: string } | null => {
    if (record.basePath === null || record.provider !== "openbao") return null;
    const [mount = "", project = ""] = record.basePath.split("/");
    const path = `${project}/forge-${item.slug}`;
    return { reference: { provider: "openbao", connectionId: record.id, mount, path, key: "token" }, path: `${mount}/${path}` };
  };

  wire.answer("keyManagers.move.list", () => ({
    result: {
      items: items.map((item) => ({
        kind: "forge-account",
        id: item.id,
        name: item.name,
        targets: connections.flatMap((record) => {
          const target = targetOf(record, item);
          return target === null ? [] : [{ connectionId: record.id, reference: target.reference }];
        }),
      })),
    },
  }));

  wire.answer("keyManagers.move", (params) => {
    const refused = host.refusal("keyManagers.move");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    if (record === undefined) return notFound(params["connectionId"]);
    const overwrite = params["overwrite"] === true;
    const verifyOnly = params["verifyOnly"] === true;
    if (overwrite && verifyOnly) return invalid("overwrite", "overwrite cannot come with verifyOnly, which writes nothing.");
    if (record.provider !== "openbao") return unavailable(record.provider, "move stored tokens into", "");
    if (record.basePath === null) return invalid("connectionId", `${record.label} has no base path: set one before moving.`);
    if (record.status.kind !== "signed-in") {
      return rejected("credential_source_unavailable", `The key-manager connection ${record.label} is not signed in (${record.status.message}), so nothing can be moved into it.`, {
        connectionId: record.id,
      });
    }
    const asked = params["items"] === "all" ? [...items] : (params["items"] as { readonly id: string }[]).flatMap((ref) => items.filter((item) => item.id === ref.id));
    const results: KeyManagerMoveItemResult[] = [];
    for (const item of asked) {
      const ref = { kind: "forge-account" as const, id: item.id };
      const target = targetOf(record, item) as NonNullable<ReturnType<typeof targetOf>>;
      const named = `OpenBao at ${target.path} (key token)`;
      const keeps = `the forge account ${item.name} keeps its stored token`;
      const failed = (step: "write" | "read-back", error: Extract<KeyManagerMoveItemResult, { readonly outcome: "failed" }>["error"]): void =>
        void results.push({ item: ref, outcome: "failed", step, written: false, error });
      const held = values.get(target.path);
      if (!verifyOnly) {
        if (script.writable === false) {
          offered.add(`${record.id} ${item.id}`);
          failed("write", {
            code: "cannot_write",
            message: `The login of ${record.label} may not write ${named}: nothing was written, and ${keeps}. Copy the value to paste it there by hand, then verify it to finish the move.`,
            data: { connectionId: record.id, reference: target.reference },
          });
          continue;
        }
        if (held !== undefined && held !== item.value && !overwrite) {
          failed("write", {
            code: "conflict",
            message: `A different value is at ${named} already: nothing was written, and ${keeps}. Move it with overwrite to replace that value.`,
            data: { reason: "target_exists", connectionId: record.id, reference: target.reference },
          });
          continue;
        }
        values.set(target.path, item.value);
      } else if (held === undefined) {
        failed("read-back", {
          code: "reference_not_found",
          message: `Nothing is at ${named}. Nothing is pasted at ${named} yet: paste the value there, then verify it again. The forge account ${item.name} keeps its stored token.`,
          data: { connectionId: record.id },
        });
        continue;
      } else if (held !== item.value) {
        failed("read-back", {
          code: "conflict",
          message: `${named} holds another value than the stored token of the forge account ${item.name}, so the forge account was not swapped to it. The value there and the stored token are both left as they were.`,
          data: { reason: "read_back_differs", connectionId: record.id, reference: target.reference },
        });
        continue;
      }
      items.splice(items.indexOf(item), 1);
      offered.delete(`${record.id} ${item.id}`);
      referenced.set(item.id, { connectionId: record.id, name: item.name });
      const how = verifyOnly ? `Verified the value pasted at ${named} and moved to it` : `Moved to ${named}`;
      results.push({ item: ref, outcome: "moved", reference: target.reference, storedValueDeleted: true, message: `${how}; the stored token was deleted.` });
    }
    for (const result of results) {
      if (result.outcome === "moved") event("key-manager.moved", { connectionId: record.id, item: result.item, reference: result.reference, undeleted: null });
    }
    return accepted({ items: results });
  });

  wire.answer("keyManagers.move.copyValue", (params) => {
    const refused = host.refusal("keyManagers.move.copyValue");
    if (refused) return refused;
    const record = find(params["connectionId"]);
    const ref = params["item"] as { readonly kind: "forge-account"; readonly id: string };
    const item = items.find((candidate) => candidate.id === ref.id);
    if (record === undefined || item === undefined || !offered.has(`${record.id} ${item.id}`)) {
      return rejected("not_found", "No copy of that item's value is offered: move it first, and copy its value when the move answers cannot_write.", { ...ref });
    }
    offered.delete(`${record.id} ${item.id}`);
    const target = targetOf(record, item) as NonNullable<ReturnType<typeof targetOf>>;
    event("key-manager.value-copied", { connectionId: record.id, item: ref, reference: target.reference, clientSessionId: wire.credential()?.clientSessionId ?? "fake-client-session" });
    return accepted({ item: ref, reference: target.reference, value: item.value });
  });

  return {
    keyManagerConnections: () => [...connections],
    keyManagerValue: (path) => values.get(path),
    pasteKeyManagerValue(path, value) {
      values.set(path, value);
    },
    setKeyManagerStatus(connectionId, found) {
      pending.set(connectionId, found);
    },
    holdKeyManagerLists() {
      heldLists ??= [];
      return () => {
        const waiting = heldLists ?? [];
        heldLists = null;
        for (const release of waiting) release();
      };
    },
    verifyKeyManager(connectionId) {
      const record = find(connectionId);
      if (record === undefined) throw new Error(`No key-manager connection ${connectionId} is held.`);
      verify(record);
    },
  };
};
