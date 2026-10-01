import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ForgeFetch } from "../src/forge/providers.js";

/**
 * The scripted fake forge (forge spec, "Testing Decisions"): a listener on
 * loopback port 0 serving the slice of GitHub's REST API, as an Enterprise
 * origin under `/api/v3`, and of the Gitea API under `/api/v1` that the
 * providers use, each token's answer scripted per route. GitHub's routes
 * take a bearer token and the Gitea API's the `token` scheme; a request
 * whose token has no answer on its route, or comes in the other scheme, is
 * refused 401, as a forge refuses a token it does not know. A route is
 * scripted with its query for an answer to that query alone (a page of a
 * list), else without one for every query. An answer with an `etag` header
 * answers 304 to a request whose `If-None-Match` names it, as a forge
 * answers a conditional re-read. Every request is recorded, its scheme and
 * not its token. Every path outside `/api/` is git's smart HTTP (#314),
 * served by a real `git http-backend` over bare repositories the test makes,
 * behind basic auth: a public repository reads anonymously, a private one
 * and every push ask for a credential with 401. Detection (#313) finds
 * what `detectable` scripts on each kind's version or meta route, and a
 * GitLab-shaped route is scripted with `answer`; `organisations` scripts
 * GitHub's organisation list, which answers a fine-grained token with
 * none, beside its memberships, and the Gitea API's list. `pullRequest`
 * scripts a pull request on both APIs (#317), read by its number and listed
 * among the repository's others by its head.
 */

/** What a route answers a token. */
export interface FakeForgeAnswer {
  readonly status: number;
  /** Sent as JSON. */
  readonly body?: unknown;
  /** Sent as it is, in place of a JSON body: an asset's bytes. */
  readonly raw?: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  /** Answered only once this settles: a test holds a call in flight while it sends another. */
  readonly after?: Promise<unknown>;
}

/** A request as the fake forge saw it. */
export interface FakeForgeRequest {
  readonly method: string;
  readonly path: string;
  /** The query after `?`, present only when the request had one. */
  readonly query?: string;
  /** The `Authorization` header's scheme (`Bearer`, `token`); null without one. */
  readonly scheme: string | null;
  /** The entity tag a conditional request named in `If-None-Match`, present only when it named one. */
  readonly ifNoneMatch?: string;
  /** The JSON body the request sent, present only when it sent one. */
  readonly body?: unknown;
}

/** What a route answers: an answer, or one made from the request, as a forge answers a write it carries out. */
export type FakeForgeScript = FakeForgeAnswer | ((request: FakeForgeRequest) => FakeForgeAnswer);

/** A request git made of the smart HTTP, as the fake forge saw it. */
export interface FakeGitRequest {
  readonly method: string;
  /** The path, without the query. */
  readonly path: string;
  /** The basic-auth username git sent; null for none. */
  readonly username: string | null;
  /** A shallow clone's requested depth, from its upload-pack request; absent for a full clone. */
  readonly depth?: number;
  /** The answer: 401 for a credential missing or refused. */
  readonly status: number;
}

/** A pull request as a test scripts one; every field has a preset. */
export interface FakePullRequest {
  /** Preset `open`. */
  readonly state?: "open" | "closed" | "merged";
  /** When it merged; preset: none, or `closedAt` for a merged one. */
  readonly mergedAt?: string | null;
  /** When it closed or merged; preset: none, or `MERGED_OR_CLOSED_AT` for one that is not open. */
  readonly closedAt?: string | null;
  /** The branch it is from; preset `feature`. */
  readonly head?: string;
  /** The repository its head branch is in, `owner/name`; preset: the one it is opened on. */
  readonly headRepository?: string;
}

/** When a pull request a test scripts closed or merged, unless it says. */
export const MERGED_OR_CLOSED_AT = "2026-09-24T00:00:30Z";

/** What detection may find a fake forge to be: Forgejo, Gitea, or GitHub on an Enterprise origin. */
export type DetectableKind = "forgejo" | "gitea" | "github";

/** The line Forgejo's and Gitea's API answers a caller with no credential when it asks every caller to sign in. */
export const SIGN_IN_REQUIRED = "Only signed in user is allowed to call APIs.";

/** A user as both APIs' user endpoints answer one. */
export interface FakeForgeUser {
  readonly login: string;
  readonly id: number;
}

export interface FakeForge {
  /** Where it listens: `http://127.0.0.1:<port>`, an origin as a LAN forge has one. */
  readonly origin: string;
  /**
   * Scripts what `route` (`GET /api/v1/user`, or with a query, `GET /api/v1/user/repos?page=2`) answers `token`,
   * or a request with no token for `null`, replacing what it answered before.
   */
  answer(token: string | null, route: string, answer: FakeForgeScript): void;
  /** Scripts both APIs' user endpoints to answer `token` as `user`, once `after` settles when it is given. */
  user(token: string, user: FakeForgeUser, after?: Promise<unknown>): void;
  /** Scripts both APIs to let `token` read the repository `fullName` (`owner/name`), private on `main`, and its releases, which are none. */
  repository(token: string, fullName: string): void;
  /** Scripts both APIs' repository listings to answer `token` with the repositories `fullNames`, on one page. */
  repositories(token: string, fullNames: readonly string[]): void;
  /**
   * Scripts what a caller with no credential finds on the version and meta
   * routes of `kind` at `version`: Forgejo's own route and the Gitea API's,
   * the Gitea API's alone with Forgejo's answering 404, or GitHub
   * Enterprise's meta route. With `signIn`, a Forgejo or Gitea that asks
   * every caller to sign in, answering its version routes 403.
   */
  detectable(kind: DetectableKind, version: string, options?: { readonly signIn?: boolean }): void;
  /**
   * Scripts the organisations `token` belongs to, by name, on one page:
   * GitHub's organisation list answering none, as it answers a fine-grained
   * token, beside its memberships listing each as active; and the Gitea
   * API's list.
   */
  organisations(token: string, names: readonly string[]): void;
  /**
   * Scripts the pull request `number` of `fullName` (`owner/name`) for
   * `token`, or for a caller with no credential when it is null, on both
   * APIs as each answers one: read by its number, and listed among the
   * repository's pull requests scripted for that caller, most recently
   * scripted first, GitHub's list filtered by its `head=owner:branch` query
   * and the Gitea API's answering them all. Scripting it again replaces it.
   */
  pullRequest(token: string | null, fullName: string, number: number, fields?: FakePullRequest): void;
  /** Every request of the APIs so far, in order. */
  readonly requests: readonly FakeForgeRequest[];
  /**
   * Makes a bare repository served at `<origin>/<path>.git` (`david/bank`),
   * holding one commit on `main` with `files`, or none when it is `empty`,
   * as a repository just created is; a private one answers nothing without a
   * credential. Answers where its bare repository is.
   */
  gitRepository(path: string, options?: { readonly private?: boolean; readonly empty?: boolean; readonly files?: Readonly<Record<string, string>> }): string;
  /** Accepts `username` and `password` as git's basic auth on every repository. */
  gitCredential(username: string, password: string): void;
  /** Every request git made of the smart HTTP so far, in order. */
  readonly gitRequests: readonly FakeGitRequest[];
  /**
   * A fetch for the ForgeService that sends github.com's API
   * (`https://api.github.com`) to this forge's GitHub routes, and every
   * other URL where it names.
   */
  readonly fetch: ForgeFetch;
  close(): Promise<void>;
}

/** The scheme a path's token takes: GitHub's API a bearer token, the Gitea API and its web routes the `token` scheme. */
const schemeFor = (path: string): string => (path.startsWith("/api/v3/") ? "Bearer" : "token");

/** What an answer scripted for a request with no token is kept under: no token is a line break. */
const ANONYMOUS = "\n";

/** A request's body as JSON, or as the text it is when it is not JSON. */
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const GITHUB_API = "https://api.github.com";

/**
 * git as the fake forge runs it, for itself: none of the machine's or the
 * test's configuration (a test points `HOME` at a hostile one), and an
 * identity for the commit it makes.
 */
const OWN_GIT: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "fake forge",
  GIT_AUTHOR_EMAIL: "forge@example.com",
  GIT_COMMITTER_NAME: "fake forge",
  GIT_COMMITTER_EMAIL: "forge@example.com",
};

const ownGit = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: OWN_GIT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A CGI response's header block and body: the headers end at the first empty line. */
const cgiResponse = (output: Buffer): { status: number; headers: Record<string, string>; body: Buffer } => {
  const crlf = output.indexOf("\r\n\r\n");
  const lf = output.indexOf("\n\n");
  const [end, gap] = crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : [lf, 2];
  const head = end === -1 ? "" : output.subarray(0, end).toString("latin1");
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, body: end === -1 ? output : output.subarray(end + gap) };
};

/** The username and password of a Basic `Authorization` header; null for none, or another scheme. */
const basicCredential = (header: string | undefined): { readonly username: string; readonly password: string } | null => {
  const [scheme, encoded = ""] = (header ?? "").split(" ", 2);
  if (scheme?.toLowerCase() !== "basic") return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
};

/** Starts a fake forge; the caller closes it. */
export const startFakeForge = async (): Promise<FakeForge> => {
  const answers = new Map<string, FakeForgeScript>();
  const keyOf = (token: string, route: string): string => `${token}\n${route}`;
  /** Every route scripted for any caller, without its query: one outside `/api/` is answered as scripted, never as git's. */
  const scriptedRoutes = new Set<string>();
  const script = (caller: string, route: string, answer: FakeForgeScript): void => {
    answers.set(keyOf(caller, route), answer);
    scriptedRoutes.add(route.split("?", 1)[0] ?? route);
  };
  const requests: FakeForgeRequest[] = [];
  const root = mkdtempSync(join(tmpdir(), "agent-harness-fake-forge-"));
  const gitRepositories = new Map<string, { readonly private: boolean }>();
  const gitCredentials = new Set<string>();
  const gitRequests: FakeGitRequest[] = [];
  /** The pull requests scripted per caller and repository, by number, in the order scripted. */
  const pulls = new Map<string, Map<number, FakePullRequest>>();

  /** Serves git's smart HTTP through `git http-backend`, once the request's credential passes: every push and every read of a private repository need one. */
  const serveGit = (request: IncomingMessage, response: ServerResponse, method: string, path: string, query: string): void => {
    const repository = /^\/(.+?\.git)(?:\/|$)/.exec(path)?.[1];
    const held = repository === undefined ? undefined : gitRepositories.get(repository);
    const pushing = query.includes("service=git-receive-pack") || path.endsWith("/git-receive-pack");
    const given = basicCredential(request.headers.authorization);
    const accepted = given !== null && gitCredentials.has(keyOf(given.username, given.password));
    const record = (status: number, depth?: number) => gitRequests.push({ method, path, username: given?.username ?? null, status, ...(depth !== undefined && { depth }) });
    if (held === undefined) {
      record(404);
      request.resume();
      response.writeHead(404, { "content-type": "text/plain" });
      return void response.end("Not found\n");
    }
    if ((held.private || pushing) && !accepted) {
      record(401);
      request.resume();
      response.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="fake forge"' });
      return void response.end("Unauthorized\n");
    }
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const input = Buffer.concat(body);
      let depth: number | undefined;
      for (let at = 0; at + 4 <= input.length;) {
        const size = Number.parseInt(input.subarray(at, at + 4).toString("ascii"), 16);
        if (!Number.isFinite(size)) break;
        const deepen = /^deepen ([1-9][0-9]*)\n?$/.exec(input.subarray(at + 4, at + size).toString("utf8"))?.[1];
        if (deepen !== undefined) depth = Number(deepen);
        at += Math.max(size, 4);
      }
      record(200, depth);
      const backend = spawn("git", ["http-backend"], {
        env: {
          ...OWN_GIT,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: path,
          QUERY_STRING: query,
          REQUEST_METHOD: method,
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(input.length),
          REMOTE_ADDR: "127.0.0.1",
          ...(accepted && given !== null && { REMOTE_USER: given.username }),
          ...(request.headers["content-encoding"] !== undefined && { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] }),
          ...(typeof request.headers["git-protocol"] === "string" && { GIT_PROTOCOL: request.headers["git-protocol"] }),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const output: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      backend.stdin.on("error", () => undefined);
      backend.stdin.end(input);
      backend.on("close", () => {
        const answer = cgiResponse(Buffer.concat(output));
        response.writeHead(answer.status, answer.headers);
        response.end(answer.body);
      });
    });
  };

  const respond = (response: ServerResponse, answer: FakeForgeAnswer): void => {
    if (answer.raw !== undefined) {
      response.writeHead(answer.status, { "content-type": "application/octet-stream", ...answer.headers });
      return void response.end(answer.raw);
    }
    const body = answer.body === undefined ? "" : JSON.stringify(answer.body);
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(body);
  };

  /** The answer itself, or 304 with its headers and no body when the request names its entity tag. */
  const conditional = (answer: FakeForgeAnswer, ifNoneMatch: string | undefined): FakeForgeAnswer => {
    const etag = answer.headers?.["etag"];
    return etag !== undefined && etag === ifNoneMatch ? { status: 304, ...(answer.headers !== undefined && { headers: answer.headers }) } : answer;
  };

  /** What `route` is scripted to answer the caller holding `token` (null for none): the answer for its query first, else the route's. */
  const scriptFor = (token: string | null, method: string, path: string, query: string): FakeForgeScript | undefined => {
    const caller = token ?? ANONYMOUS;
    return (query === "" ? undefined : answers.get(keyOf(caller, `${method} ${path}?${query}`))) ?? answers.get(keyOf(caller, `${method} ${path}`));
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const [path = "/", query = ""] = (request.url ?? "/").split("?", 2);
    const authorization = request.headers.authorization;
    const [scheme = null, token = ""] = (authorization ?? "").split(" ", 2);
    const script = scriptFor(authorization === undefined ? null : token, method, path, query);
    if (!path.startsWith("/api/") && !scriptedRoutes.has(`${method} ${path}`)) return serveGit(request, response, method, path, query);
    const ifNoneMatch = request.headers["if-none-match"];
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const seen: FakeForgeRequest = {
        method,
        path,
        ...(query !== "" && { query }),
        scheme: scheme === "" ? null : scheme,
        ...(ifNoneMatch !== undefined && { ifNoneMatch }),
        ...(text !== "" && { body: parseBody(text) }),
      };
      requests.push(seen);
      // A token in the other API's scheme is one the forge does not know.
      if (script === undefined || (authorization !== undefined && scheme !== schemeFor(path))) return respond(response, { status: 401, body: { message: "Bad credentials" } });
      const scripted = typeof script === "function" ? script(seen) : script;
      const answer = conditional(scripted, ifNoneMatch);
      if (scripted.after === undefined) return respond(response, answer);
      void scripted.after.then(() => respond(response, answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    answer: (token, route, answer) => script(token ?? ANONYMOUS, route, answer),
    user(token, user, after) {
      for (const route of ["GET /api/v3/user", "GET /api/v1/user"]) {
        script(token, route, { status: 200, body: { ...user, full_name: "", email: "" }, ...(after !== undefined && { after }) });
      }
    },
    repository(token, fullName) {
      for (const api of ["/api/v3", "/api/v1"]) {
        const body = { full_name: fullName, private: true, default_branch: "main", html_url: `${origin}/${fullName}` };
        script(token, `GET ${api}/repos/${fullName}`, { status: 200, body });
        script(token, `GET ${api}/repos/${fullName}/releases`, { status: 200, body: [] });
      }
    },
    repositories(token, fullNames) {
      for (const api of ["/api/v3", "/api/v1"]) {
        script(token, `GET ${api}/user/repos`, { status: 200, body: fullNames.map((fullName) => ({ full_name: fullName })) });
      }
    },
    detectable(kind, version, options = {}) {
      const answered = options.signIn === true ? { status: 403, body: { message: SIGN_IN_REQUIRED } } : { status: 200, body: { version } };
      if (kind === "github") return script(ANONYMOUS, "GET /api/v3/meta", { status: 200, body: { verifiable_password_authentication: false, installed_version: version, packages: [] } });
      script(ANONYMOUS, "GET /api/forgejo/v1/version", kind === "forgejo" ? answered : { status: 404, raw: "Not found.\n", headers: { "content-type": "text/plain" } });
      script(ANONYMOUS, "GET /api/v1/version", answered);
    },
    organisations(token, names) {
      script(token, "GET /api/v3/user/orgs", { status: 200, body: [] });
      const memberships = names.map((login, index) => ({ state: "active", role: "member", organization: { login, id: 100 + index } }));
      script(token, "GET /api/v3/user/memberships/orgs", { status: 200, body: memberships });
      script(token, "GET /api/v1/user/orgs", { status: 200, body: names.map((name, index) => ({ id: 100 + index, name, username: name, full_name: "" })) });
    },
    pullRequest(token, fullName, number, fields = {}) {
      const caller = token ?? ANONYMOUS;
      const key = keyOf(caller, fullName);
      const held = pulls.get(key) ?? new Map<number, FakePullRequest>();
      // Scripted again, it is the most recently updated.
      held.delete(number);
      held.set(number, fields);
      pulls.set(key, held);
      /** The pull request as an API answers it: GitHub's merged by `merged_at`, the Gitea API's by `merged` too. */
      const body = (api: "/api/v3" | "/api/v1", pull: number, scripted: FakePullRequest) => {
        const state = scripted.state ?? "open";
        const closedAt = scripted.closedAt !== undefined ? scripted.closedAt : state === "open" ? null : MERGED_OR_CLOSED_AT;
        const mergedAt = scripted.mergedAt !== undefined ? scripted.mergedAt : state === "merged" ? closedAt : null;
        return {
          number: pull,
          title: `Pull request ${pull}`,
          body: "",
          state: state === "open" ? "open" : "closed",
          ...(api === "/api/v1" && { merged: state === "merged" }),
          merged_at: mergedAt,
          closed_at: closedAt,
          head: { ref: scripted.head ?? "feature", sha: "0123abcd", repo: { full_name: scripted.headRepository ?? fullName } },
          base: { ref: "main" },
          html_url: `${origin}/${fullName}/${api === "/api/v3" ? "pull" : "pulls"}/${pull}`,
        };
      };
      const listed = (api: "/api/v3" | "/api/v1") => [...held.entries()].reverse().map(([pull, scripted]) => ({ scripted, answer: body(api, pull, scripted) }));
      for (const api of ["/api/v3", "/api/v1"] as const) {
        script(caller, `GET ${api}/repos/${fullName}/pulls/${number}`, { status: 200, body: body(api, number, fields) });
      }
      script(caller, `GET /api/v3/repos/${fullName}/pulls`, (request) => {
        const head = new URLSearchParams(request.query ?? "").get("head");
        const answers = listed("/api/v3").filter(({ scripted }) => head === null || head === `${(scripted.headRepository ?? fullName).split("/")[0]}:${scripted.head ?? "feature"}`);
        return { status: 200, body: answers.map(({ answer }) => answer) };
      });
      script(caller, `GET /api/v1/repos/${fullName}/pulls`, () => ({ status: 200, body: listed("/api/v1").map(({ answer }) => answer) }));
    },
    requests,
    gitRepository(path, options = {}) {
      const repository = `${path}.git`;
      const bare = join(root, repository);
      mkdirSync(dirname(bare), { recursive: true });
      ownGit(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
      gitRepositories.set(repository, { private: options.private ?? false });
      if (options.empty === true) return bare;
      const work = mkdtempSync(join(tmpdir(), "agent-harness-fake-forge-work-"));
      try {
        ownGit(work, "init", "--quiet", "--initial-branch=main");
        for (const [name, content] of Object.entries(options.files ?? { "README.md": `# ${path}\n` })) {
          mkdirSync(dirname(join(work, name)), { recursive: true });
          writeFileSync(join(work, name), content);
        }
        ownGit(work, "add", ".");
        ownGit(work, "commit", "--quiet", "-m", "first");
        ownGit(work, "push", "--quiet", bare, "main");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      return bare;
    },
    gitCredential: (username, password) => void gitCredentials.add(keyOf(username, password)),
    gitRequests,
    fetch: (url, init) => fetch(url.startsWith(`${GITHUB_API}/`) ? `${origin}/api/v3${url.slice(GITHUB_API.length)}` : url, init),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Closing twice is closing once: a test may close it to have the forge stop answering, before its cleanup does.
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close((error) => {
          rmSync(root, { recursive: true, force: true });
          if (error) reject(error);
          else resolve();
        });
      }),
  };
};

/** An origin nothing listens on: a port the fake forge took and let go. */
export const unreachableOrigin = async (): Promise<string> => {
  const forge = await startFakeForge();
  await forge.close();
  return forge.origin;
};
