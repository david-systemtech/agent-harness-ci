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
 * (`token`, `root`), and `auth/token/revoke-self` revokes it. Sealed on
 * demand, it answers 503 to everything but `sys/seal-status`, as OpenBao
 * does. A credential no script names is refused as OpenBao refuses it. Every
 * request is recorded by method and path, never with its token or body.
 * Later tickets extend it (capabilities, policies, KV reads and writes).
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
  /** Makes `token` a token OpenBao knows, looked up as `login` says. */
  token(token: string, login: FakeLogin): void;
  /** Makes `token` a root token. */
  root(token: string): void;
  seal(): void;
  unseal(): void;
  /** The tokens logins minted, in order. */
  readonly minted: readonly string[];
  /** Whether `token` is live: known and not revoked. */
  live(token: string): boolean;
  /** Every request so far, in order. */
  readonly requests: readonly FakeOpenBaoRequest[];
  close(): Promise<void>;
}

/** The test run's certificates: a CA, the fake's key and certificate issued by it for 127.0.0.1, and a second CA that issued nothing the fake serves. */
interface TestCertificates {
  readonly ca: string;
  readonly otherCa: string;
  readonly key: string;
  readonly certificate: string;
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
    openssl("req", ...newKey, "-keyout", "leaf.key", "-out", "leaf.csr", "-config", config, "-subj", "/CN=127.0.0.1");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", config, "-extensions", "leaf");
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    certificates = { ca: read("ca.pem"), otherCa: read("other-ca.pem"), key: read("leaf.key"), certificate: read("leaf.pem") };
    return certificates;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A token as the fake keeps it: its lookup's answer, and whether it is revoked. */
interface FakeToken {
  readonly policies: readonly string[];
  readonly ttlSeconds: number;
  readonly renewable: boolean;
  readonly displayName: string;
  revoked: boolean;
}

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
  const minted: string[] = [];
  const requests: FakeOpenBaoRequest[] = [];
  let sealed = false;

  const loginKey = (mount: string, ...credential: string[]): string => JSON.stringify([mount, ...credential]);

  const lookup = (token: FakeToken) => ({
    data: {
      accessor: "accessor-for-tests",
      display_name: token.displayName,
      expire_time: token.ttlSeconds === 0 ? null : new Date(now().getTime() + token.ttlSeconds * 1000).toISOString(),
      id: "[the token]",
      policies: token.policies,
      renewable: token.renewable,
      ttl: token.ttlSeconds,
      type: "service",
    },
  });

  /** Answers a login as scripted: a token minted for a login, or the refusal; nothing scripted is OpenBao's own refusal. */
  const logIn = async (response: ServerResponse, answer: FakeAnswer | undefined, displayName: string, unknown: string): Promise<void> => {
    if (answer === undefined) return send(response, 400, { errors: [unknown] });
    await answer.after;
    if (isRefusal(answer)) return send(response, answer.status, { errors: [answer.error] });
    const token = `login-${minted.length + 1}-token-for-tests`;
    minted.push(token);
    const held: FakeToken = { policies: answer.policies, ttlSeconds: answer.ttlSeconds ?? 3600, renewable: answer.renewable ?? true, displayName: answer.displayName ?? displayName, revoked: false };
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
    if (path === "sys/seal-status") return send(response, 200, { type: "shamir", initialized: true, sealed, t: 1, n: 1, progress: 0 });
    if (sealed) return send(response, 503, { errors: ["Vault is sealed"] });
    const header = request.headers["x-vault-token"];
    const presented = typeof header === "string" ? tokens.get(header) : undefined;
    const known = presented !== undefined && !presented.revoked ? presented : undefined;
    if (method === "GET" && path === "auth/token/lookup-self") return known === undefined ? send(response, 403, { errors: ["permission denied"] }) : send(response, 200, lookup(known));
    if (method === "POST" && path === "auth/token/revoke-self") {
      if (known === undefined) return send(response, 403, { errors: ["permission denied"] });
      known.revoked = true;
      return send(response, 204);
    }
    const login = /^auth\/(.+)\/login(?:\/([^/]+))?$/.exec(path);
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    address: `https://127.0.0.1:${port}`,
    ca,
    mount: (path, method) => void mounts.set(path, method),
    approle: (roleId, secretId, answer, mount = "approle") => void logins.set(loginKey(mount, roleId, secretId), answer),
    userpass: (username, password, answer, mount = "userpass") => void logins.set(loginKey(mount, username, password), answer),
    token: (token, login) => void tokens.set(token, { policies: login.policies, ttlSeconds: login.ttlSeconds ?? 3600, renewable: login.renewable ?? true, displayName: login.displayName ?? "token", revoked: false }),
    root: (token) => void tokens.set(token, { policies: ["root"], ttlSeconds: 0, renewable: false, displayName: "root", revoked: false }),
    seal: () => void (sealed = true),
    unseal: () => void (sealed = false),
    minted,
    live: (token) => tokens.get(token)?.revoked === false,
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
