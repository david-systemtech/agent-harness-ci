import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
 * not its token. Later tickets extend it (detection, organisations, git's
 * smart HTTP).
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
  /** Every request so far, in order. */
  readonly requests: readonly FakeForgeRequest[];
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

/** Starts a fake forge; the caller closes it. */
export const startFakeForge = async (): Promise<FakeForge> => {
  const answers = new Map<string, FakeForgeAnswer>();
  const requests: FakeForgeRequest[] = [];
  const keyOf = (token: string, route: string): string => `${token}\n${route}`;

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
    fetch: (url, init) => fetch(url.startsWith(`${GITHUB_API}/`) ? `${origin}/api/v3${url.slice(GITHUB_API.length)}` : url, init),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Closing twice is closing once: a test may close it to have the forge stop answering, before its cleanup does.
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

/** An origin nothing listens on: a port the fake forge took and let go. */
export const unreachableOrigin = async (): Promise<string> => {
  const forge = await startFakeForge();
  await forge.close();
  return forge.origin;
};
