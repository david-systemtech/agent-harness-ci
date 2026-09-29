import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GIT_CREDENTIAL_PATH } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliContext } from "./cli.js";

/**
 * `agent-harness git-credential <slug> <verb>` at its lower seam (forge
 * spec, "Testing Decisions"; #314): the verb run in-process against a
 * scripted credential route on loopback, as the pairing tests script the
 * network, and a scripted proxy. What git reads is the verb's standard
 * output; what a person reads is its one line on standard error.
 */

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** A test value in place of a run-scoped secret. */
const SECRET = "secret-for-tests";

/** A request the scripted server saw. */
interface Seen {
  readonly method: string;
  /** The request target as sent: a path, or the absolute URL a proxy is sent. */
  readonly target: string;
  readonly host: string | undefined;
  readonly authorization: string | undefined;
  readonly proxyAuthorization: string | undefined;
  readonly body: unknown;
}

/** An HTTP server on loopback port 0 that records every request and answers what `respond` says. */
const scripted = async (respond: (seen: Seen, response: ServerResponse) => void = () => undefined) => {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const entry: Seen = {
        method: request.method ?? "",
        target: request.url ?? "",
        host: request.headers.host,
        authorization: request.headers.authorization,
        proxyAuthorization: request.headers["proxy-authorization"],
        body: text === "" ? null : (JSON.parse(text) as unknown),
      };
      seen.push(entry);
      respond(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { address: `127.0.0.1:${port}`, seen };
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** A route that answers every `get` with a credential. */
const answering = (seen: Seen, response: ServerResponse): void => {
  if ((seen.body as { action?: string } | null)?.action === "erase") {
    response.writeHead(204);
    return void response.end();
  }
  json(response, 200, { username: "david", password: "token-for-tests" });
};

/** What git writes to the helper for `https://git.example.com:5526`. */
const ATTRIBUTES = "protocol=https\nhost=git.example.com:5526\n\n";

/** Runs the verb as git would, with `env` as its whole environment. */
const helper = async (verb: string, env: Record<string, string>, options: { readonly input?: string; readonly timeoutMs?: number } = {}) => {
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    stdin: async () => options.input ?? ATTRIBUTES,
    env,
    ...(options.timeoutMs !== undefined && { gitCredentialTimeoutMs: options.timeoutMs }),
  };
  const code = await runCli(["git-credential", "git_example_com", verb], context);
  return { code, out, err };
};

const withRoute = (address: string, extra: Record<string, string> = {}): Record<string, string> => ({
  AGENT_HARNESS_ADDRESS: address,
  AGENT_HARNESS_RUN_SECRET: SECRET,
  ...extra,
});

/** Checks the one line a person reads when git gets no credential: the origin and the fix. */
const expectOneLine = (err: string, says: RegExp): void => {
  expect(err.endsWith("\n")).toBe(true);
  expect(err.trimEnd().split("\n")).toHaveLength(1);
  expect(err).toContain("https://git.example.com:5526");
  expect(err).toContain("Set up, Forges");
  expect(err).toMatch(says);
};

describe("agent-harness git-credential get", () => {
  it("posts git's attributes and its slug with the secret, and prints the username and password", async () => {
    const route = await scripted(answering);
    const answer = await helper("get", withRoute(route.address), { input: "protocol=https\nhost=git.example.com:5526\nwwwauth[]=Basic realm=\"forge\"\n\n" });
    expect(answer).toEqual({ code: 0, out: "username=david\npassword=token-for-tests\n", err: "" });
    expect(route.seen).toEqual([
      {
        method: "POST",
        target: GIT_CREDENTIAL_PATH,
        host: route.address,
        authorization: `Bearer ${SECRET}`,
        proxyAuthorization: undefined,
        body: { action: "get", slug: "git_example_com", protocol: "https", host: "git.example.com:5526" },
      },
    ]);
  });

  it("prints quit=1 and one line naming the origin and the fix when the process has no secret", async () => {
    const route = await scripted(answering);
    for (const env of [{ AGENT_HARNESS_ADDRESS: route.address }, { AGENT_HARNESS_RUN_SECRET: SECRET }]) {
      const answer = await helper("get", env);
      expect(answer.out).toBe("quit=1\n");
      expect(answer.code).toBe(0);
      expectOneLine(answer.err, /run-scoped secret/);
    }
    expect(route.seen).toEqual([]);
  });

  it("prints quit=1 and one line when the environment is unreachable", async () => {
    const route = await scripted();
    const address = route.address;
    await cleanups.pop()?.();
    const answer = await helper("get", withRoute(address));
    expect(answer.out).toBe("quit=1\n");
    expectOneLine(answer.err, new RegExp(`${address.replaceAll(".", "\\.")} did not answer`));
  });

  it("answers from its slug's FORGE_<SLUG>_TOKEN when the environment cannot be reached, as from inside a Linux sandbox's own network (#315)", async () => {
    const route = await scripted();
    const address = route.address;
    await cleanups.pop()?.();
    const answer = await helper("get", withRoute(address, { FORGE_GIT_EXAMPLE_COM_TOKEN: "token-for-tests", FORGE_TOKEN: "other-token-for-tests" }));
    expect(answer).toEqual({ code: 0, out: "username=x-access-token\npassword=token-for-tests\n", err: "" });
  });

  it("never answers from the token variable when the environment answers, refusing, or does not answer in time", async () => {
    const refusing = await scripted((_seen, response) => json(response, 401, { code: "unauthorized", message: "The run-scoped secret is missing, or not one this environment holds.", data: {} }));
    const token = { FORGE_GIT_EXAMPLE_COM_TOKEN: "token-for-tests" };
    const refused = await helper("get", withRoute(refusing.address, token));
    expect(refused.out).toBe("quit=1\n");
    expectOneLine(refused.err, /run-scoped secret is missing/);
    const silent = await scripted(() => undefined);
    const late = await helper("get", withRoute(silent.address, token), { timeoutMs: 300 });
    expect(late.out).toBe("quit=1\n");
    expectOneLine(late.err, /did not answer within/);
  });

  it("prints quit=1 and the environment's reason when the origin is outside the secret's set, or its credential is unavailable", async () => {
    for (const [status, body] of [
      [401, { code: "unauthorized", message: "No forge account this secret names serves https://git.example.com:5526.", data: {} }],
      [503, { code: "credential_unavailable", message: "gh is not signed in to git.example.com as david: sign in again in Set up, Forges.", data: { origin: "https://git.example.com:5526" } }],
    ] as const) {
      const route = await scripted((_seen, response) => json(response, status, body));
      const answer = await helper("get", withRoute(route.address));
      expect(answer.out).toBe("quit=1\n");
      expectOneLine(answer.err, new RegExp(body.message.slice(0, 20)));
    }
  });

  it("prints quit=1 and one line when fifteen seconds pass without an answer", async () => {
    const route = await scripted(() => undefined);
    const began = Date.now();
    const answer = await helper("get", withRoute(route.address), { timeoutMs: 300 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(answer.out).toBe("quit=1\n");
    expectOneLine(answer.err, /did not answer within/);
  });

  it("sends its call through the proxy the standard proxy variables name, unless no_proxy names the environment's host", async () => {
    const route = await scripted(answering);
    const proxy = await scripted(answering);
    const through = await helper("get", withRoute(route.address, { http_proxy: `http://someone:proxy-password@${proxy.address}` }));
    expect(through.out).toBe("username=david\npassword=token-for-tests\n");
    expect(route.seen).toEqual([]);
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatchObject({
      target: `http://${route.address}${GIT_CREDENTIAL_PATH}`,
      host: route.address,
      authorization: `Bearer ${SECRET}`,
      proxyAuthorization: `Basic ${Buffer.from("someone:proxy-password").toString("base64")}`,
    });

    const upper = await helper("get", withRoute(route.address, { HTTP_PROXY: `http://${proxy.address}` }));
    expect(upper.out).toBe("username=david\npassword=token-for-tests\n");
    expect(proxy.seen).toHaveLength(2);

    const direct = await helper("get", withRoute(route.address, { http_proxy: `http://${proxy.address}`, no_proxy: "localhost,127.0.0.1" }));
    expect(direct.out).toBe("username=david\npassword=token-for-tests\n");
    expect(proxy.seen).toHaveLength(2);
    expect(route.seen).toHaveLength(1);
  });
});

describe("agent-harness git-credential erase and store", () => {
  it("reports an erase without the password git was refused, and prints nothing", async () => {
    const route = await scripted(answering);
    const answer = await helper("erase", withRoute(route.address), { input: "protocol=https\nhost=git.example.com:5526\nusername=david\npassword=token-for-tests\n\n" });
    expect(answer).toEqual({ code: 0, out: "", err: "" });
    expect(route.seen.map((seen) => seen.body)).toEqual([{ action: "erase", slug: "git_example_com", protocol: "https", host: "git.example.com:5526" }]);
  });

  it("ignores store", async () => {
    const route = await scripted(answering);
    const answer = await helper("store", withRoute(route.address), { input: "protocol=https\nhost=git.example.com:5526\nusername=david\npassword=token-for-tests\n\n" });
    expect(answer).toEqual({ code: 0, out: "", err: "" });
    expect(route.seen).toEqual([]);
  });
});
