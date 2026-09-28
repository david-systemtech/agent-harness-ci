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
 * and every push ask for a credential with 401. Later tickets extend it
 * (detection, organisations).
 */

/** What a route answers a token. */
export interface FakeForgeAnswer {
  readonly status: number;
  readonly body?: unknown;
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
}

/** A request git made of the smart HTTP, as the fake forge saw it. */
export interface FakeGitRequest {
  readonly method: string;
  /** The path, without the query. */
  readonly path: string;
  /** The basic-auth username git sent; null for none. */
  readonly username: string | null;
  /** The answer: 401 for a credential missing or refused. */
  readonly status: number;
}

/** A user as both APIs' user endpoints answer one. */
export interface FakeForgeUser {
  readonly login: string;
  readonly id: number;
}

export interface FakeForge {
  /** Where it listens: `http://127.0.0.1:<port>`, an origin as a LAN forge has one. */
  readonly origin: string;
  /** Scripts what `route` (`GET /api/v1/user`, or with a query, `GET /api/v1/user/repos?page=2`) answers `token`, replacing what it answered before. */
  answer(token: string, route: string, answer: FakeForgeAnswer): void;
  /** Scripts both APIs' user endpoints to answer `token` as `user`, once `after` settles when it is given. */
  user(token: string, user: FakeForgeUser, after?: Promise<unknown>): void;
  /** Scripts both APIs to let `token` read the repository `fullName` (`owner/name`) and its releases, which are none. */
  repository(token: string, fullName: string): void;
  /** Scripts both APIs' repository listings to answer `token` with the repositories `fullNames`, on one page. */
  repositories(token: string, fullNames: readonly string[]): void;
  /** Every request of the APIs so far, in order. */
  readonly requests: readonly FakeForgeRequest[];
  /**
   * Makes a bare repository served at `<origin>/<path>.git` (`david/bank`),
   * holding one commit on `main` with `files`; a private one answers nothing
   * without a credential. Answers where its bare repository is.
   */
  gitRepository(path: string, options?: { readonly private?: boolean; readonly files?: Readonly<Record<string, string>> }): string;
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

/** The API a path belongs to, and the scheme its token takes. */
const schemeFor = (path: string): string | null => (path.startsWith("/api/v3/") ? "Bearer" : path.startsWith("/api/v1/") ? "token" : null);

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
  const answers = new Map<string, FakeForgeAnswer>();
  const requests: FakeForgeRequest[] = [];
  const keyOf = (token: string, route: string): string => `${token}\n${route}`;
  const root = mkdtempSync(join(tmpdir(), "agent-harness-fake-forge-"));
  const gitRepositories = new Map<string, { readonly private: boolean }>();
  const gitCredentials = new Set<string>();
  const gitRequests: FakeGitRequest[] = [];

  /** Serves git's smart HTTP through `git http-backend`, once the request's credential passes: every push and every read of a private repository need one. */
  const serveGit = (request: IncomingMessage, response: ServerResponse, method: string, path: string, query: string): void => {
    const repository = /^\/(.+?\.git)(?:\/|$)/.exec(path)?.[1];
    const held = repository === undefined ? undefined : gitRepositories.get(repository);
    const pushing = query.includes("service=git-receive-pack") || path.endsWith("/git-receive-pack");
    const given = basicCredential(request.headers.authorization);
    const accepted = given !== null && gitCredentials.has(keyOf(given.username, given.password));
    const record = (status: number) => gitRequests.push({ method, path, username: given?.username ?? null, status });
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
    record(200);
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const input = Buffer.concat(body);
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
    const body = answer.body === undefined ? "" : JSON.stringify(answer.body);
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(body);
  };

  /** The answer itself, or 304 with its headers and no body when the request names its entity tag. */
  const conditional = (answer: FakeForgeAnswer, ifNoneMatch: string | undefined): FakeForgeAnswer => {
    const etag = answer.headers?.["etag"];
    return etag !== undefined && etag === ifNoneMatch ? { status: 304, ...(answer.headers !== undefined && { headers: answer.headers }) } : answer;
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const [path = "/", query = ""] = (request.url ?? "/").split("?", 2);
    if (!path.startsWith("/api/")) return serveGit(request, response, method, path, query);
    const [scheme = null, token = ""] = (request.headers.authorization ?? "").split(" ", 2);
    const ifNoneMatch = request.headers["if-none-match"];
    requests.push({ method, path, ...(query !== "" && { query }), scheme: scheme === "" ? null : scheme, ...(ifNoneMatch !== undefined && { ifNoneMatch }) });
    request.resume();
    const scripted = (query === "" ? undefined : answers.get(keyOf(token, `${method} ${path}?${query}`))) ?? answers.get(keyOf(token, `${method} ${path}`));
    if (scripted === undefined || scheme !== schemeFor(path)) return respond(response, { status: 401, body: { message: "Bad credentials" } });
    const answer = conditional(scripted, ifNoneMatch);
    if (scripted.after === undefined) return respond(response, answer);
    void scripted.after.then(() => respond(response, answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    answer: (token, route, answer) => void answers.set(keyOf(token, route), answer),
    user(token, user, after) {
      for (const route of ["GET /api/v3/user", "GET /api/v1/user"]) {
        answers.set(keyOf(token, route), { status: 200, body: { ...user, full_name: "", email: "" }, ...(after !== undefined && { after }) });
      }
    },
    repository(token, fullName) {
      for (const api of ["/api/v3", "/api/v1"]) {
        answers.set(keyOf(token, `GET ${api}/repos/${fullName}`), { status: 200, body: { full_name: fullName, private: true } });
        answers.set(keyOf(token, `GET ${api}/repos/${fullName}/releases`), { status: 200, body: [] });
      }
    },
    repositories(token, fullNames) {
      for (const api of ["/api/v3", "/api/v1"]) {
        answers.set(keyOf(token, `GET ${api}/user/repos`), { status: 200, body: fullNames.map((fullName) => ({ full_name: fullName })) });
      }
    },
    requests,
    gitRepository(path, options = {}) {
      const repository = `${path}.git`;
      const bare = join(root, repository);
      mkdirSync(dirname(bare), { recursive: true });
      ownGit(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
      const work = mkdtempSync(join(tmpdir(), "agent-harness-fake-forge-work-"));
      try {
        ownGit(work, "init", "--quiet", "--initial-branch=main");
        for (const [name, content] of Object.entries(options.files ?? { "README.md": `# ${path}\n` })) writeFileSync(join(work, name), content);
        ownGit(work, "add", ".");
        ownGit(work, "commit", "--quiet", "-m", "first");
        ownGit(work, "push", "--quiet", bare, "main");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      gitRepositories.set(repository, { private: options.private ?? false });
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
