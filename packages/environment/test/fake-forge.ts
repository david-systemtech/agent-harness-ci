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
 * refused 401, as a forge refuses a token it does not know. Every request
 * is recorded, its scheme and not its token. Later tickets extend it
 * (read probes, detection, organisations, git's smart HTTP).
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
  /** The `Authorization` header's scheme (`Bearer`, `token`); null without one. */
  readonly scheme: string | null;
}

/** A user as both APIs' user endpoints answer one. */
export interface FakeForgeUser {
  readonly login: string;
  readonly id: number;
}

export interface FakeForge {
  /** Where it listens: `http://127.0.0.1:<port>`, an origin as a LAN forge has one. */
  readonly origin: string;
  /** Scripts what `route` (`GET /api/v1/user`) answers `token`, replacing what it answered before. */
  answer(token: string, route: string, answer: FakeForgeAnswer): void;
  /** Scripts both APIs' user endpoints to answer `token` as `user`, once `after` settles when it is given. */
  user(token: string, user: FakeForgeUser, after?: Promise<unknown>): void;
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

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const [scheme = null, token = ""] = (request.headers.authorization ?? "").split(" ", 2);
    requests.push({ method, path, scheme: scheme === "" ? null : scheme });
    request.resume();
    const scripted = answers.get(keyOf(token, `${method} ${path}`));
    if (scripted === undefined || scheme !== schemeFor(path)) return respond(response, { status: 401, body: { message: "Bad credentials" } });
    if (scripted.after === undefined) return respond(response, scripted);
    void scripted.after.then(() => respond(response, scripted));
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
    requests,
    fetch: (url, init) => fetch(url.startsWith(`${GITHUB_API}/`) ? `${origin}/api/v3${url.slice(GITHUB_API.length)}` : url, init),
    close: () =>
      new Promise<void>((resolve, reject) => {
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
