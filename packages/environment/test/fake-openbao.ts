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
 * which OpenBao knows it no more: a token login's maximum life. Sealed on
 * demand, it answers 503 to everything but `sys/seal-status` and a route
 * the test scripted (below), as OpenBao does. A credential no script names
 * is refused as OpenBao refuses it.
 *
 * Policies are texts the test gives (#366): `sys/capabilities-self` answers
 * a token's capabilities on a path from its policies' texts, and
 * `sys/policies/acl/<name>` answers a policy's text to a token whose
 * policies grant `read` there. Any route can be scripted to answer
 * otherwise (an error that echoes a secret, an answer held back), which it
 * does sealed or not, ahead of every rule above; and the
 * certificate it presents swapped mid-test. Every request is recorded by
 * method and path, never with its token or body. Later tickets extend it
 * (child tokens, KV reads and writes).
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
  /** Makes `token` a token OpenBao knows, issued now and looked up as `login` says: it lives for its time to live, its maximum life, since it is never renewed. */
  token(token: string, login: FakeLogin): void;
  /** Makes `token` a root token. */
  root(token: string): void;
  seal(): void;
  unseal(): void;
  /** Gives the policy `name` its text, in OpenBao's policy language: the capabilities it grants, and whether a token holding it may read other policies' texts. */
  policy(name: string, text: string): void;
  /** Scripts what `route` (`GET auth/token/lookup-self`) answers from now on, in place of the fake's own answer; null to answer as the fake does. */
  answer(route: string, answer: FakeRouteAnswer | null): void;
  /** Presents `which` certificate from the next handshake on, closing every connection held, as a key manager restarted with it would. Preset `leaf`. */
  present(which: FakePresented): void;
  /** How many connections the fake has accepted, a request sent over them or not. */
  connections(): number;
  /** The tokens logins minted, in order. */
  readonly minted: readonly string[];
  /** Whether `token` is live: known, not revoked and within its time to live. */
  live(token: string): boolean;
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

/** A token as the fake keeps it: its lookup's answer, when it was issued on the fake's clock, and whether it is revoked. */
interface FakeToken {
  readonly policies: readonly string[];
  readonly ttlSeconds: number;
  readonly renewable: boolean;
  readonly displayName: string;
  readonly issuedAt: number;
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
  const minted: string[] = [];
  const requests: FakeOpenBaoRequest[] = [];
  let sealed = false;
  let connections = 0;

  /** When a token stops living: its issue time and its time to live on the fake's clock; never for a time to live of 0. */
  const expiresAt = (token: FakeToken): number | null => (token.ttlSeconds === 0 ? null : token.issuedAt + token.ttlSeconds * 1000);
  const living = (token: FakeToken | undefined): token is FakeToken => {
    if (token === undefined || token.revoked) return false;
    const end = expiresAt(token);
    return end === null || now().getTime() < end;
  };
  const newToken = (login: FakeLogin, displayName: string): FakeToken => ({
    policies: login.policies,
    ttlSeconds: login.ttlSeconds ?? 3600,
    renewable: login.renewable ?? true,
    displayName: login.displayName ?? displayName,
    issuedAt: now().getTime(),
    revoked: false,
  });

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

  const loginKey = (mount: string, ...credential: string[]): string => JSON.stringify([mount, ...credential]);

  const lookup = (token: FakeToken) => {
    const end = expiresAt(token);
    return {
      data: {
        accessor: "accessor-for-tests",
        creation_ttl: token.ttlSeconds,
        display_name: token.displayName,
        expire_time: end === null ? null : new Date(end).toISOString(),
        id: "[the token]",
        issue_time: new Date(token.issuedAt).toISOString(),
        policies: token.policies,
        renewable: token.renewable,
        ttl: end === null ? 0 : Math.max(0, Math.floor((end - now().getTime()) / 1000)),
        type: "service",
      },
    };
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
    const method = request.method ?? "GET";
    requests.push({ method, path });
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
    root: (token) => void tokens.set(token, { policies: ["root"], ttlSeconds: 0, renewable: false, displayName: "root", issuedAt: now().getTime(), revoked: false }),
    seal: () => void (sealed = true),
    unseal: () => void (sealed = false),
    policy: (name, text) => void policies.set(name, text),
    answer: (route, answer) => void (answer === null ? routes.delete(route) : routes.set(route, answer)),
    present(which) {
      const { otherKey, otherCertificate } = testCertificates();
      server.setSecureContext(which === "other-ca" ? { key: otherKey, cert: otherCertificate } : { key, cert: which === "chain" ? `${certificate}${ca}` : certificate });
      server.closeAllConnections();
    },
    connections: () => connections,
    minted,
    live: (token) => living(tokens.get(token)),
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
