import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The scripted fake OpenBao (key-managers spec, "Testing Decisions"): a
 * listener on loopback port 0 over TLS, its certificate issued for
 * 127.0.0.1 by a test CA made for the test run, serving the slice of
 * OpenBao's HTTP API the key-manager connections use. AppRole logins at
 * `auth/<mount>/login` and userpass logins at `auth/<mount>/login/<name>`
 * answer each credential as the test scripted it (a login's policies, time
 * to live and display name, or a refusal), minting a token for a login;
 * `auth/token/lookup-self` looks a minted token up, or one the test gave
 * (`token`, `root`), and `auth/token/revoke-self` revokes it. A token lives
 * from when it was issued for its time to live on the fake's clock, past
 * which OpenBao knows it no more. `auth/token/renew-self` (#369) gives a
 * token its time to live again from now, as the increment asks or as it was
 * created, or its period for a periodic one, never past its maximum life:
 * the role's (`token_max_ttl`, which its lookup does not name) or its
 * explicit one (`explicit_max_ttl`, which it does), from when it was issued.
 * A test revokes a token on demand, as an operator would. Sealed on
 * demand, it answers 503 to everything but `sys/seal-status` and a route
 * the test scripted (below), as OpenBao does. A credential no script names
 * is refused as OpenBao refuses it, and one scripted again is refused on
 * demand.
 *
 * Policies are texts the test gives (#366): `sys/capabilities-self` answers
 * a token's capabilities on a path from its policies' texts, and
 * `sys/policies/acl/<name>` answers a policy's text to a token whose
 * policies grant `read` there. Any route can be scripted to answer
 * otherwise (an error that echoes a secret, an answer held back), which it
 * does sealed or not, ahead of every rule above; and the
 * certificate it presents swapped mid-test. Every request is recorded by
 * method and path, never with its token or body; a list (`GET` with
 * `?list=true`) is recorded as `LIST`.
 *
 * KV secrets engines (#370) are mounted at version 1 or 2 and hold the
 * secrets the test writes: version 1 reads at `<mount>/<path>` and lists at
 * `<mount>/<path>/`, version 2 at `<mount>/data/<path>` and
 * `<mount>/metadata/<path>/`. As OpenBao does, a request's path is checked
 * against the token's policies before anything is looked up, so a path the
 * token may not read answers 403 whether it or its mount is there or not;
 * one it may read with nothing there answers 404. The mount's UI endpoint
 * (`sys/internal/ui/mounts/<path>`) answers the mount's type and version to
 * a token with any access under it, and 403 alike for a mount that is not
 * there, so it cannot be used to find mounts; with no path it lists the
 * mounts the token has access under. A write (#371), `POST` or `PUT` at a
 * secret's path (version 2's under `data/`, its fields under `data` in the
 * body), replaces the secret with the fields given; the token's policies
 * must grant `create` there for a secret that is not there yet and `update`
 * for one that is, as OpenBao's existence check asks. Tokens are created
 * at the token-create paths (#368), children dying with their parent.
 */

/** A login a credential answers with: its policies, and what its token's lookup says of it. */
export interface FakeLogin {
  readonly policies: readonly string[];
  /** Preset 3600. */
  readonly ttlSeconds?: number;
  /** Preset true. */
  readonly renewable?: boolean;
  /** Preset: OpenBao's for the method (`approle`, `userpass-<name>`, `token`). */
  readonly displayName?: string;
  /** Its role's `token_max_ttl` (#369): no renewal takes it past this from its issue unless it is periodic, and its lookup does not say so. Preset: none. */
  readonly maxTtlSeconds?: number;
  /** Its `explicit_max_ttl` (#369), which its lookup names: no renewal takes it past this from its issue, a periodic one's included. Preset: none. */
  readonly explicitMaxTtlSeconds?: number;
  /** Its `period` (#369), which its lookup names: every renewal gives it this much again, whatever increment is asked. Preset: not periodic. */
  readonly periodSeconds?: number;
}

/** A token role (#368): whether the tokens created against it are orphans, and the policies it allows, when it bounds them. */
export interface FakeRole {
  readonly orphan?: boolean;
  readonly allowedPolicies?: readonly string[];
}

/** A token as the fake holds it, for a test to read: what it was created with, and whose child it is. */
export interface FakeIssued {
  readonly policies: readonly string[];
  readonly ttlSeconds: number;
  readonly renewable: boolean;
  readonly displayName: string;
  readonly meta: Readonly<Record<string, string>>;
  /** The token it was created by and dies with; null for an orphan, or a token a login minted or a test gave. */
  readonly parent: string | null;
  /** The token role it was created against; null for none. */
  readonly role: string | null;
}

/** A refusal a credential answers with: the status and OpenBao's error line. */
export interface FakeRefusal {
  readonly status: number;
  readonly error: string;
}

/** What a credential is scripted to answer, once `after` settles when it is given. */
export type FakeAnswer = (FakeLogin | FakeRefusal) & { readonly after?: Promise<unknown> };

/** What a scripted route answers in place of the fake's own answer: a status with OpenBao's error line, or with a body, once `after` settles. */
export interface FakeRouteAnswer {
  readonly status: number;
  readonly error?: string;
  readonly body?: unknown;
  readonly after?: Promise<unknown>;
}

/** Which certificate the fake presents: its own leaf, its leaf with the test CA after it, or a leaf another CA issued for the same address. */
export type FakePresented = "leaf" | "chain" | "other-ca";

/** A request as the fake saw it. */
export interface FakeOpenBaoRequest {
  readonly method: string;
  /** The path under `/v1/`. */
  readonly path: string;
}

export interface FakeOpenBao {
  /** Where it listens: `https://127.0.0.1:<port>`. */
  readonly address: string;
  /** The test CA its certificate is issued by, as PEM. */
  readonly ca: string;
  /** Mounts an auth method at `path`; `approle` and `userpass` are mounted at their names from the start. */
  mount(path: string, method: "approle" | "userpass"): void;
  /** Scripts what an AppRole login with this role id and secret id answers at `mount` (preset `approle`). */
  approle(roleId: string, secretId: string, answer: FakeAnswer, mount?: string): void;
  /** Scripts what a userpass login as `username` with `password` answers at `mount` (preset `userpass`). */
  userpass(username: string, password: string, answer: FakeAnswer, mount?: string): void;
  /** Makes `token` a token OpenBao knows, issued now and looked up as `login` says: it lives for its time to live, or as its renewals say up to its maximum life. */
  token(token: string, login: FakeLogin): void;
  /** Makes `token` a root token. */
  root(token: string): void;
  /** Adds the token role `name` (#368): an orphan's when `orphan` is set, and bounding a token's policies to `allowedPolicies` when given. */
  role(name: string, role?: FakeRole): void;
  seal(): void;
  unseal(): void;
  /** Gives the policy `name` its text, in OpenBao's policy language: the capabilities it grants, and whether a token holding it may read other policies' texts. */
  policy(name: string, text: string): void;
  /** Mounts a KV secrets engine of `version` at `path` (`personal`, `secret/team`), holding no secret yet. */
  kv(path: string, version: 1 | 2): void;
  /** Writes the secret at `path` under the KV mount `mount`, replacing what it held: its keys and their values. */
  secret(mount: string, path: string, data: Record<string, unknown>): void;
  /** The secret at `path` under the KV mount `mount` as it holds it now, its keys and their values; undefined for none. */
  stored(mount: string, path: string): Record<string, unknown> | undefined;
  /** Scripts what `route` (`GET auth/token/lookup-self`, `LIST personal/metadata/`) answers from now on, in place of the fake's own answer; null to answer as the fake does. */
  answer(route: string, answer: FakeRouteAnswer | null): void;
  /** Lets `route` do what it does, but ends its answer only once `until` settles (#368): the caller hears late of what is done already. Null answers at once again. */
  delay(route: string, until: Promise<unknown> | null): void;
  /** Presents `which` certificate from the next handshake on, closing every connection held, as a key manager restarted with it would. Preset `leaf`. */
  present(which: FakePresented): void;
  /** How many connections the fake has accepted, a request sent over them or not. */
  connections(): number;
  /** The tokens logins minted, in order. */
  readonly minted: readonly string[];
  /** The tokens created at the token-create paths (#368), in order. */
  readonly created: readonly string[];
  /** What the fake holds of a token it issued or was given: undefined for one it does not know. */
  issued(token: string): FakeIssued | undefined;
  /** Whether `token` is live: known, not revoked and within its time to live. */
  live(token: string): boolean;
  /** When each renewal of `token` was answered (#369), on the fake's clock, in order. */
  renewals(token: string): readonly string[];
  /** Revokes `token` as an operator would, its children dying with it (#369). */
  revoke(token: string): void;
  /** Every request so far, in order. */
  readonly requests: readonly FakeOpenBaoRequest[];
  close(): Promise<void>;
}

/** The test run's certificates: a CA, the fake's key and certificate issued by it for 127.0.0.1, and a second CA with a key and certificate it issued for the same address. */
interface TestCertificates {
  readonly ca: string;
  readonly otherCa: string;
  readonly key: string;
  readonly certificate: string;
  readonly otherKey: string;
  readonly otherCertificate: string;
}

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = agent-harness test CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
authorityKeyIdentifier = keyid
`;

let certificates: TestCertificates | undefined;

/**
 * Makes the certificates once per test process with `openssl`, as the fake
 * forge runs `git`: nothing that looks like a key is ever committed. Each
 * key is an EC P-256 key, made and signed for one day.
 */
export const testCertificates = (): TestCertificates => {
  if (certificates !== undefined) return certificates;
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-openbao-ca-"));
  try {
    const config = join(dir, "openssl.cnf");
    writeFileSync(config, OPENSSL_CONFIG);
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    const newKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    for (const name of ["ca", "other-ca"]) {
      openssl("req", "-x509", ...newKey, "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "1", "-config", config, "-extensions", "ca", "-subj", `/CN=agent-harness ${name}`);
    }
    for (const [leaf, issuer] of [
      ["leaf", "ca"],
      ["other-leaf", "other-ca"],
    ] as const) {
      openssl("req", ...newKey, "-keyout", `${leaf}.key`, "-out", `${leaf}.csr`, "-config", config, "-subj", "/CN=127.0.0.1");
      openssl("x509", "-req", "-in", `${leaf}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-out", `${leaf}.pem`, "-days", "1", "-extfile", config, "-extensions", "leaf");
    }
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    certificates = {
      ca: read("ca.pem"),
      otherCa: read("other-ca.pem"),
      key: read("leaf.key"),
      certificate: read("leaf.pem"),
      otherKey: read("other-leaf.key"),
      otherCertificate: read("other-leaf.pem"),
    };
    return certificates;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A token as the fake keeps it: what it was issued with, when on the fake's clock, until when it lives (a renewal moves it), its limits, its renewals, and whether it is revoked. */
interface FakeToken extends FakeIssued {
  readonly issuedAt: number;
  /** When it stops living; null for a token that does not expire. */
  expiresAt: number | null;
  /** Its role's maximum life, not named by its lookup; 0 for none. */
  readonly maxTtlSeconds: number;
  /** Its explicit maximum life, named by its lookup; 0 for none. */
  readonly explicitMaxTtlSeconds: number;
  /** Its period; 0 for a token that is not periodic. */
  readonly periodSeconds: number;
  /** When each renewal was answered, as ISO instants. */
  readonly renewedAt: string[];
  revoked: boolean;
}

/** OpenBao's own `default` policy, as far as the fake reads it: nothing outside the token's own paths. */
const DEFAULT_POLICY = `path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
path "sys/capabilities-self" { capabilities = ["update"] }
path "cubbyhole/*" { capabilities = ["create", "read", "update", "delete", "list"] }`;

/** A policy text's rules: each path, and the capabilities it grants there. */
const rulesOf = (text: string): { readonly path: string; readonly capabilities: readonly string[] }[] =>
  [...text.matchAll(/path\s+"([^"]+)"\s*\{([^}]*)\}/g)].map(([, path = "", body = ""]) => ({
    path,
    capabilities: [.../capabilities\s*=\s*\[([^\]]*)\]/.exec(body)?.[1]?.matchAll(/"([^"]+)"/g) ?? []].map(([, capability = ""]) => capability),
  }));

/** Whether a policy path matches `path`: exactly, or as a prefix ending in `*`. */
const matches = (rule: string, path: string): boolean => (rule.endsWith("*") ? path.startsWith(rule.slice(0, -1)) : rule === path);

/** Whether a policy path reaches anything under `mount`, as OpenBao's UI endpoint asks before it answers a mount. */
const reachesUnder = (rule: string, mount: string): boolean => rule.startsWith(`${mount}/`) || (rule.endsWith("*") && `${mount}/`.startsWith(rule.slice(0, -1)));

/** The names directly under `prefix` (empty, or ending in `/`) among `paths`: a secret's name, or a folder's ending in `/`, each once and sorted. */
const namesUnder = (paths: Iterable<string>, prefix: string): string[] => {
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  return [...names].sort();
};

const isRefusal = (answer: FakeLogin | FakeRefusal): answer is FakeRefusal => "status" in answer;

const readBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        resolve(null);
      }
    });
  });

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/** Starts a fake OpenBao; `now` dates its tokens' expiry, preset the real time. */
export const startFakeOpenBao = async (options: { readonly now?: () => Date } = {}): Promise<FakeOpenBao> => {
  const now = options.now ?? (() => new Date());
  const { ca, key, certificate } = testCertificates();
  const mounts = new Map<string, "approle" | "userpass">([
    ["approle", "approle"],
    ["userpass", "userpass"],
  ]);
  const logins = new Map<string, FakeAnswer>();
  const tokens = new Map<string, FakeToken>();
  const policies = new Map<string, string>([["default", DEFAULT_POLICY]]);
  const routes = new Map<string, FakeRouteAnswer>();
  const delays = new Map<string, Promise<unknown>>();
  /** The KV mounts, by path, with their version and the secrets they hold by path. */
  const kvMounts = new Map<string, { readonly version: 1 | 2; readonly secrets: Map<string, Record<string, unknown>> }>();
  const minted: string[] = [];
  const created: string[] = [];
  const roles = new Map<string, FakeRole>();
  const requests: FakeOpenBaoRequest[] = [];
  let sealed = false;
  let connections = 0;

  /** Whether a token lives: known, not revoked, within its time to live on the fake's clock, and, a child, while its parent does. */
  const living = (token: FakeToken | undefined): token is FakeToken => {
    if (token === undefined || token.revoked) return false;
    if (token.expiresAt !== null && now().getTime() >= token.expiresAt) return false;
    return token.parent === null || living(tokens.get(token.parent));
  };
  /** A token issued now with `ttlSeconds` to live (0 for none), as a login, a test or a create gives it. */
  const issue = (
    fields: Omit<FakeIssued, "meta" | "parent" | "role"> &
      Partial<Pick<FakeIssued, "meta" | "parent" | "role"> & Pick<FakeToken, "maxTtlSeconds" | "explicitMaxTtlSeconds" | "periodSeconds">>,
  ): FakeToken => {
    const issuedAt = now().getTime();
    return {
      meta: {},
      parent: null,
      role: null,
      maxTtlSeconds: 0,
      explicitMaxTtlSeconds: 0,
      periodSeconds: 0,
      ...fields,
      issuedAt,
      expiresAt: fields.ttlSeconds === 0 ? null : issuedAt + fields.ttlSeconds * 1000,
      renewedAt: [],
      revoked: false,
    };
  };
  const newToken = (login: FakeLogin, displayName: string): FakeToken =>
    issue({
      policies: login.policies,
      ttlSeconds: login.periodSeconds ?? login.ttlSeconds ?? 3600,
      renewable: login.renewable ?? true,
      displayName: login.displayName ?? displayName,
      maxTtlSeconds: login.maxTtlSeconds ?? 0,
      explicitMaxTtlSeconds: login.explicitMaxTtlSeconds ?? 0,
      periodSeconds: login.periodSeconds ?? 0,
    });

  /**
   * When a token's maximum life ends, as OpenBao's renewal reckons it from
   * its issue: its explicit maximum, and for a token that is not periodic its
   * role's too, the nearer; null for none.
   */
  const maximumEnd = (token: FakeToken): number | null => {
    const limits = [token.explicitMaxTtlSeconds, token.periodSeconds > 0 ? 0 : token.maxTtlSeconds].filter((limit) => limit > 0);
    return limits.length === 0 ? null : token.issuedAt + Math.min(...limits) * 1000;
  };

  /**
   * A token's capabilities on `path`, from its policies' texts: in each
   * policy the rules of the exact pattern, else of the longest prefix, merged;
   * across policies their union, unless one denies. None is `deny`, as
   * OpenBao answers.
   */
  const capabilitiesOn = (token: FakeToken, path: string): string[] => {
    const granted = new Set<string>();
    for (const name of token.policies) {
      if (name === "root") return ["root"];
      const rules = rulesOf(policies.get(name) ?? "").filter((rule) => matches(rule.path, path));
      const closest = rules.some((rule) => rule.path === path) ? path : rules.map((rule) => rule.path).sort((a, b) => b.length - a.length)[0];
      for (const rule of rules) if (rule.path === closest) for (const capability of rule.capabilities) granted.add(capability);
    }
    return granted.size === 0 || granted.has("deny") ? ["deny"] : [...granted];
  };

  /** Whether `token` may reach anything under `mount`: a root token, or a policy rule granting something there. */
  const hasMountAccess = (token: FakeToken, mount: string): boolean =>
    token.policies.some(
      (name) => name === "root" || rulesOf(policies.get(name) ?? "").some((rule) => reachesUnder(rule.path, mount) && rule.capabilities.some((capability) => capability !== "deny")),
    );

  /** The KV mount `path` is under, the longest that is; undefined for none. */
  const kvMountOf = (path: string): string | undefined =>
    [...kvMounts.keys()].filter((mount) => path === mount || path.startsWith(`${mount}/`)).sort((a, b) => b.length - a.length)[0];

  /** A mount as OpenBao's UI endpoint describes it. */
  const describeMount = (mount: string) => {
    const version = kvMounts.get(mount)?.version;
    return { type: "kv", path: `${mount}/`, description: "", options: version === 2 ? { version: "2" } : null };
  };

  /** Where a secret's name sits in a request's path under a KV mount of `version`: the path itself on version 1, under `data/` on version 2; undefined for a path the version does not route there. */
  const secretNameOf = (version: 1 | 2, mount: string, path: string): string | undefined => {
    const rest = path === mount ? "" : path.slice(mount.length + 1);
    if (version === 1) return rest;
    return rest.startsWith("data/") ? rest.slice("data/".length) : undefined;
  };

  /**
   * Answers a KV write under a mount: the secret replaced with the fields
   * given, the body itself on version 1 and its `data` on version 2, once the
   * token's policies grant `create` for a new secret or `update` for one
   * there, as OpenBao's existence check asks.
   */
  const writeKv = (response: ServerResponse, token: FakeToken | undefined, mount: string, path: string, fields: Record<string, unknown>): void => {
    const { version, secrets } = kvMounts.get(mount) ?? { version: 1, secrets: new Map() };
    const name = secretNameOf(version, mount, path);
    if (name === undefined || name === "") return send(response, 404, { errors: [`no handler for route "${path}". route entry not found.`] });
    const wanted = secrets.has(name) ? "update" : "create";
    if (token === undefined || !capabilitiesOn(token, path).some((capability) => capability === wanted || capability === "root")) return send(response, 403, { errors: ["permission denied"] });
    const data = version === 2 ? fields["data"] : fields;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return send(response, 400, { errors: ["no data provided"] });
    secrets.set(name, { ...(data as Record<string, unknown>) });
    if (version === 1) return send(response, 204);
    send(response, 200, { data: { created_time: now().toISOString(), deletion_time: "", destroyed: false, version: 1 } });
  };

  /**
   * Answers a KV read or list under a mount: version 1's secrets sit at the
   * path, version 2's under `data/` and their lists under `metadata/`. A
   * path the version does not route is no handler's.
   */
  const serveKv = (response: ServerResponse, mount: string, method: string, path: string): void => {
    const { version, secrets } = kvMounts.get(mount) ?? { version: 1, secrets: new Map() };
    let rest = path === mount ? "" : path.slice(mount.length + 1);
    if (version === 2) {
      const area = method === "LIST" ? "metadata/" : "data/";
      if (!rest.startsWith(area) && `${rest}/` !== area) return send(response, 404, { errors: [`no handler for route "${path}". route entry not found.`] });
      rest = rest.startsWith(area) ? rest.slice(area.length) : "";
    }
    if (method === "LIST") {
      const prefix = rest === "" || rest.endsWith("/") ? rest : `${rest}/`;
      const keys = namesUnder(secrets.keys(), prefix);
      return keys.length === 0 ? send(response, 404, { errors: [] }) : send(response, 200, { data: { keys } });
    }
    const data = secrets.get(rest);
    if (data === undefined) return send(response, 404, { errors: [] });
    if (version === 1) return send(response, 200, { data });
    send(response, 200, { data: { data, metadata: { version: 1, created_time: now().toISOString(), deletion_time: "", destroyed: false } } });
  };

  const loginKey = (mount: string, ...credential: string[]): string => JSON.stringify([mount, ...credential]);

  const lookup = (token: FakeToken) => {
    const end = token.expiresAt;
    return {
      data: {
        accessor: "accessor-for-tests",
        creation_ttl: token.ttlSeconds,
        display_name: token.displayName,
        expire_time: end === null ? null : new Date(end).toISOString(),
        explicit_max_ttl: token.explicitMaxTtlSeconds,
        id: "[the token]",
        issue_time: new Date(token.issuedAt).toISOString(),
        meta: token.meta,
        orphan: token.parent === null,
        ...(token.periodSeconds > 0 && { period: token.periodSeconds }),
        policies: token.policies,
        renewable: token.renewable,
        ttl: end === null ? 0 : Math.max(0, Math.floor((end - now().getTime()) / 1000)),
        type: "service",
      },
    };
  };

  /** A duration as OpenBao's API takes one: whole seconds, or a number of seconds, minutes or hours (`3600s`, `20m`, `1h`); undefined for none or one it cannot read. */
  const durationOf = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    const parts = typeof value === "string" ? /^(\d+)([smh]?)$/.exec(value) : null;
    if (parts === null) return undefined;
    return Number(parts[1]) * ({ "": 1, s: 1, m: 60, h: 3600 } as const)[parts[2] as "" | "s" | "m" | "h"];
  };

  /**
   * Answers a token's creation at `auth/token/create` or a role's path, by
   * the presented token: `update` there, as OpenBao's ACL checks; then the
   * policies asked held to the role's allowed policies, or else to a subset
   * of the creator's, `default` added when the creator holds it (or, under a
   * role that bounds them, unless asked not to); an orphan under a role
   * that says so, else a child of the creator.
   */
  const createToken = (response: ServerResponse, presented: string, creator: FakeToken, path: string, roleName: string | null, fields: Record<string, unknown>): void => {
    if (!capabilitiesOn(creator, path).some((capability) => capability === "update" || capability === "root")) return send(response, 403, { errors: ["permission denied"] });
    const role = roleName === null ? undefined : roles.get(roleName);
    if (roleName !== null && role === undefined) return send(response, 400, { errors: [`unknown role ${roleName}`] });
    const asked = [...new Set(Array.isArray(fields["policies"]) ? fields["policies"].map(String) : [])];
    const withoutDefault = fields["no_default_policy"] === true;
    let granted: string[];
    if (role?.allowedPolicies !== undefined) {
      const allowed = new Set([...role.allowedPolicies, "default"]);
      if (asked.some((policy) => !allowed.has(policy))) {
        return send(response, 400, { errors: [`token policies (${JSON.stringify(asked)}) must be subset of the role's allowed policies (${JSON.stringify(role.allowedPolicies)})`] });
      }
      granted = withoutDefault ? asked : [...new Set([...asked, "default"])];
    } else {
      const root = creator.policies.includes("root");
      if (!root && asked.some((policy) => !creator.policies.includes(policy))) return send(response, 400, { errors: ["child policies must be subset of parent"] });
      granted = !withoutDefault && creator.policies.includes("default") ? [...new Set([...asked, "default"])] : asked;
    }
    granted.sort();
    const displayName = typeof fields["display_name"] === "string" && fields["display_name"] !== "" ? `token-${fields["display_name"]}` : "token";
    const meta = typeof fields["meta"] === "object" && fields["meta"] !== null ? Object.fromEntries(Object.entries(fields["meta"]).map(([key, value]) => [key, String(value)])) : {};
    const orphan = role?.orphan === true;
    const token = `run-${created.length + 1}-token-for-tests`;
    const held = issue({
      policies: granted,
      ttlSeconds: durationOf(fields["ttl"]) ?? 3600,
      renewable: fields["renewable"] !== false,
      displayName,
      meta,
      parent: orphan ? null : presented,
      role: roleName,
    });
    created.push(token);
    tokens.set(token, held);
    send(response, 200, {
      auth: { client_token: token, accessor: "accessor-for-tests", policies: granted, token_policies: granted, metadata: meta, lease_duration: held.ttlSeconds, renewable: held.renewable, orphan },
    });
  };

  /** Answers a login as scripted: a token minted for a login, or the refusal; nothing scripted is OpenBao's own refusal. */
  const logIn = async (response: ServerResponse, answer: FakeAnswer | undefined, displayName: string, unknown: string): Promise<void> => {
    if (answer === undefined) return send(response, 400, { errors: [unknown] });
    await answer.after;
    if (isRefusal(answer)) return send(response, answer.status, { errors: [answer.error] });
    const token = `login-${minted.length + 1}-token-for-tests`;
    minted.push(token);
    const held = newToken(answer, displayName);
    tokens.set(token, held);
    send(response, 200, {
      auth: { client_token: token, accessor: "accessor-for-tests", policies: held.policies, token_policies: held.policies, lease_duration: held.ttlSeconds, renewable: held.renewable },
    });
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "https://127.0.0.1");
    const path = url.pathname.replace(/^\/v1\//, "");
    const method = request.method === "GET" && url.searchParams.get("list") === "true" ? "LIST" : (request.method ?? "GET");
    requests.push({ method, path });
    const delayed = delays.get(`${method} ${path}`);
    if (delayed !== undefined) {
      const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
      response.end = ((...args: unknown[]) => {
        void delayed.then(() => end(...args));
        return response;
      }) as typeof response.end;
    }
    const body = await readBody(request);
    const scripted = routes.get(`${method} ${path}`);
    if (scripted !== undefined) {
      await scripted.after;
      return send(response, scripted.status, scripted.body ?? (scripted.error === undefined ? undefined : { errors: [scripted.error] }));
    }
    if (path === "sys/seal-status") return send(response, 200, { type: "shamir", initialized: true, sealed, t: 1, n: 1, progress: 0 });
    if (sealed) return send(response, 503, { errors: ["Vault is sealed"] });
    const header = request.headers["x-vault-token"];
    const presented = typeof header === "string" ? tokens.get(header) : undefined;
    const known = living(presented) ? presented : undefined;
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (method === "GET" && path === "auth/token/lookup-self") return known === undefined ? send(response, 403, { errors: ["permission denied"] }) : send(response, 200, lookup(known));
    if (method === "POST" && path === "sys/capabilities-self") {
      if (known === undefined) return send(response, 403, { errors: ["permission denied"] });
      const paths = Array.isArray(fields["paths"]) ? fields["paths"].map(String) : typeof fields["path"] === "string" ? [fields["path"]] : [];
      if (paths.length === 0) return send(response, 400, { errors: ["paths must be supplied"] });
      const answered: Record<string, unknown> = Object.fromEntries(paths.map((each) => [each, capabilitiesOn(known, each)]));
      if (paths.length === 1) answered["capabilities"] = answered[paths[0] ?? ""];
      return send(response, 200, { ...answered, data: answered });
    }
    const policyRead = /^sys\/policies\/acl\/([^/]+)$/.exec(path);
    if (method === "GET" && policyRead !== null) {
      const name = decodeURIComponent(policyRead[1] ?? "");
      if (known === undefined || !capabilitiesOn(known, path).some((capability) => capability === "read" || capability === "root")) return send(response, 403, { errors: ["permission denied"] });
      const text = policies.get(name);
      return text === undefined ? send(response, 404, { errors: [`no policy named: ${name}`] }) : send(response, 200, { data: { name, policy: text } });
    }
    if (method === "POST" && path === "auth/token/revoke-self") {
      if (known === undefined) return send(response, 403, { errors: ["permission denied"] });
      known.revoked = true;
      return send(response, 204);
    }
    if (method === "POST" && path === "auth/token/renew-self") {
      if (known === undefined) return send(response, 403, { errors: ["permission denied"] });
      if (!known.renewable) return send(response, 400, { errors: ["lease is not renewable"] });
      // A periodic token gets its period whatever is asked; any token is held to its maximum life, the answer saying what is left of it.
      let ttl = known.periodSeconds > 0 ? known.periodSeconds : (durationOf(fields["increment"]) ?? known.ttlSeconds);
      const end = maximumEnd(known);
      const warnings: string[] = [];
      if (end !== null) {
        const left = Math.floor((end - now().getTime()) / 1000);
        if (left <= 0) return send(response, 400, { errors: ["past the max TTL, cannot renew"] });
        if (ttl > left) {
          warnings.push(`TTL of "${ttl}s" exceeded the effective max_ttl of "${left}s"; TTL value is capped accordingly`);
          ttl = left;
        }
      }
      known.expiresAt = now().getTime() + ttl * 1000;
      known.renewedAt.push(now().toISOString());
      return send(response, 200, {
        auth: { client_token: header, accessor: "accessor-for-tests", policies: known.policies, lease_duration: ttl, renewable: true },
        ...(warnings.length > 0 && { warnings }),
      });
    }
    const create = /^auth\/token\/create(?:\/([^/]+))?$/.exec(path);
    if (method === "POST" && create !== null) {
      if (known === undefined || typeof header !== "string") return send(response, 403, { errors: ["permission denied"] });
      return createToken(response, header, known, path, create[1] === undefined ? null : decodeURIComponent(create[1]), fields);
    }
    // Split at the first `/login`, as OpenBao routes by the mount's prefix: a user named login is still a userpass login.
    const login = /^auth\/(.+?)\/login(?:\/([^/]+))?$/.exec(path);
    if (method === "POST" && login !== null) {
      const [, mount = "", username] = login;
      const kind = mounts.get(mount);
      if (kind === "approle" && username === undefined) {
        return logIn(response, logins.get(loginKey(mount, String(fields["role_id"]), String(fields["secret_id"]))), "approle", "invalid role or secret ID");
      }
      if (kind === "userpass" && username !== undefined) {
        const name = decodeURIComponent(username);
        return logIn(response, logins.get(loginKey(mount, name, String(fields["password"]))), `userpass-${name}`, "invalid username or password");
      }
    }
    if (method === "GET" && path === "sys/internal/ui/mounts") {
      if (known === undefined) return send(response, 403, { errors: ["permission denied"] });
      // Sorted, as OpenBao's JSON gives a map's keys.
      const visible = [...kvMounts.keys(), "cubbyhole"].filter((mount) => hasMountAccess(known, mount)).sort();
      const secret = Object.fromEntries(visible.map((mount) => [`${mount}/`, mount === "cubbyhole" ? { type: "cubbyhole", path: "cubbyhole/", description: "", options: null } : describeMount(mount)]));
      return send(response, 200, { data: { secret, auth: {} } });
    }
    const uiMount = /^sys\/internal\/ui\/mounts\/(.+)$/.exec(path);
    if (method === "GET" && uiMount !== null) {
      const asked = decodeURIComponent(uiMount[1] ?? "").replace(/\/$/, "");
      const mount = kvMountOf(asked);
      // A mount that is not there answers as one the token may not see, so the endpoint cannot be used to find mounts.
      if (known === undefined || mount === undefined || !hasMountAccess(known, mount)) {
        return send(response, 403, { errors: [`preflight capability check returned 403, please ensure client's policies grant access to path "${asked}/"`] });
      }
      return send(response, 200, { data: describeMount(mount) });
    }
    if (method === "POST" || method === "PUT") {
      const mount = kvMountOf(path);
      if (mount !== undefined) return writeKv(response, known, mount, path, fields);
    }
    if (method === "GET" || method === "LIST") {
      // The token's policies first, as OpenBao checks them before it routes: a path it may not read is refused whether it is there or not.
      const wanted = method === "LIST" ? "list" : "read";
      const aclPath = method === "LIST" && !path.endsWith("/") ? `${path}/` : path;
      if (known === undefined || !capabilitiesOn(known, aclPath).some((capability) => capability === wanted || capability === "root")) return send(response, 403, { errors: ["permission denied"] });
      const mount = kvMountOf(path.replace(/\/$/, ""));
      if (mount !== undefined) return serveKv(response, mount, method, path.replace(/\/$/, ""));
    }
    send(response, 404, { errors: [`no handler for route "${path}". route entry not found.`] });
  };

  const server = createServer({ key, cert: certificate }, (request, response) => {
    serve(request, response).catch((error: unknown) => send(response, 500, { errors: [String(error)] }));
  });
  server.on("connection", () => void (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    address: `https://127.0.0.1:${port}`,
    ca,
    mount: (path, method) => void mounts.set(path, method),
    approle: (roleId, secretId, answer, mount = "approle") => void logins.set(loginKey(mount, roleId, secretId), answer),
    userpass: (username, password, answer, mount = "userpass") => void logins.set(loginKey(mount, username, password), answer),
    token: (token, login) => void tokens.set(token, newToken(login, "token")),
    root: (token) => void tokens.set(token, issue({ policies: ["root"], ttlSeconds: 0, renewable: false, displayName: "root" })),
    role: (name, role = {}) => void roles.set(name, role),
    seal: () => void (sealed = true),
    unseal: () => void (sealed = false),
    policy: (name, text) => void policies.set(name, text),
    kv: (path, version) => void kvMounts.set(path, { version, secrets: new Map() }),
    secret(mount, path, data) {
      const held = kvMounts.get(mount);
      if (held === undefined) throw new Error(`No KV mount ${mount} on the fake OpenBao.`);
      held.secrets.set(path, { ...data });
    },
    stored(mount, path) {
      const data = kvMounts.get(mount)?.secrets.get(path);
      return data === undefined ? undefined : { ...data };
    },
    answer: (route, answer) => void (answer === null ? routes.delete(route) : routes.set(route, answer)),
    delay: (route, until) => void (until === null ? delays.delete(route) : delays.set(route, until)),
    present(which) {
      const { otherKey, otherCertificate } = testCertificates();
      server.setSecureContext(which === "other-ca" ? { key: otherKey, cert: otherCertificate } : { key, cert: which === "chain" ? `${certificate}${ca}` : certificate });
      server.closeAllConnections();
    },
    connections: () => connections,
    minted,
    created,
    issued(token) {
      const held = tokens.get(token);
      if (held === undefined) return undefined;
      const { policies, ttlSeconds, renewable, displayName, meta, parent, role } = held;
      return { policies, ttlSeconds, renewable, displayName, meta, parent, role };
    },
    live: (token) => living(tokens.get(token)),
    renewals: (token) => [...(tokens.get(token)?.renewedAt ?? [])],
    revoke(token) {
      const held = tokens.get(token);
      if (held === undefined) throw new Error(`The fake OpenBao holds no token ${token}.`);
      held.revoked = true;
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

/** An https address nothing listens on: loopback's port 1, which no test binds, so no listener can take it meanwhile. */
export const UNREACHABLE_OPENBAO = "https://127.0.0.1:1";
