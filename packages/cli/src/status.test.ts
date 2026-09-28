import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_PATH, PROTOCOL_VERSION, type DiscoveryDocument } from "@agent-harness/contracts";
import { HARNESS_VERSION, NO_LAUNCHER, startEnvironment } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliContext } from "./cli.js";
import { discoverEnvironment } from "./discover.js";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const document: DiscoveryDocument = {
  environmentId: "0b6f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f",
  environmentName: "SYSTEM-SERVER",
  harnessVersion: HARNESS_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  authPolicy: "local-only",
  readiness: "ready",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers `respond` and records the URLs it was asked for. */
const stubFetch = (respond: (url: string, init?: RequestInit) => Promise<Response>) => {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return respond(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, urls };
};

const refused = () => Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7433") }));

const cli = (fetch: typeof globalThis.fetch) => {
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    fetch,
  };
  return { context, out: () => out, err: () => err };
};

describe("asking the discovery URL", () => {
  it("returns the environment's discovery document from the loopback discovery path on the port", async () => {
    const { fetch, urls } = stubFetch(async () => json(document));
    expect(await discoverEnvironment(fetch, 7433)).toEqual({ kind: "environment", document });
    expect(urls).toEqual([`http://127.0.0.1:7433${DISCOVERY_PATH}`]);
  });

  it("reports nothing answering when the connection is refused", async () => {
    const { fetch } = stubFetch(refused);
    expect(await discoverEnvironment(fetch, 7433)).toEqual({ kind: "none" });
  });

  it("reports nothing answering when the answer does not come within the timeout", async () => {
    const { fetch } = stubFetch(
      (_, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    expect(await discoverEnvironment(fetch, 7433, { timeoutMs: 20 })).toEqual({ kind: "none" });
  });

  it("reports something else answering when the answer is not a discovery document", async () => {
    for (const response of [
      () => json({ hello: "world" }),
      () => json(document, 404),
      () => new Response("<html></html>", { status: 200 }),
    ]) {
      const { fetch } = stubFetch(async () => response());
      expect(await discoverEnvironment(fetch, 7433)).toMatchObject({ kind: "other" });
    }
  });
});

describe("agent-harness status", () => {
  it("prints the environment's identity, version and readiness, and exits 0", async () => {
    const run = cli(stubFetch(async () => json(document)).fetch);
    expect(await runCli(["status"], run.context)).toBe(0);
    expect(run.out()).toBe(
      [
        "Environment: SYSTEM-SERVER (0b6f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f)",
        `Version: agent-harness ${HARNESS_VERSION}, protocol ${PROTOCOL_VERSION}`,
        "Readiness: ready",
        "Address: http://127.0.0.1:7433",
        "",
      ].join("\n"),
    );
    expect(run.err()).toBe("");
  });

  it("says when the environment runs another version than this CLI", async () => {
    const run = cli(stubFetch(async () => json({ ...document, harnessVersion: "9.9.9", readiness: "starting" })).fetch);
    expect(await runCli(["status"], run.context)).toBe(0);
    expect(run.out()).toContain(`Version: agent-harness 9.9.9, protocol ${PROTOCOL_VERSION} (this CLI is ${HARNESS_VERSION})\n`);
    expect(run.out()).toContain("Readiness: starting\n");
  });

  it("says so plainly and exits 3 when nothing answers", async () => {
    const run = cli(stubFetch(refused).fetch);
    expect(await runCli(["status"], run.context)).toBe(3);
    expect(run.out()).toBe("No environment answers at http://127.0.0.1:7433.\n");
  });

  it("says so and exits 3 when something that is not an environment answers", async () => {
    const run = cli(stubFetch(async () => json({ hello: "world" })).fetch);
    expect(await runCli(["status"], run.context)).toBe(3);
    expect(run.out()).toMatch(/^Something answers at http:\/\/127\.0\.0\.1:7433, but not as an agent-harness environment/);
  });

  it("asks on the port it is given", async () => {
    const stub = stubFetch(refused);
    const run = cli(stub.fetch);
    expect(await runCli(["status", "--port", "9100"], run.context)).toBe(3);
    expect(stub.urls).toEqual([`http://127.0.0.1:9100${DISCOVERY_PATH}`]);
    expect(run.out()).toBe("No environment answers at http://127.0.0.1:9100.\n");
  });

  it("prints JSON with --json, answering or not", async () => {
    const answering = cli(stubFetch(async () => json(document)).fetch);
    expect(await runCli(["status", "--json"], answering.context)).toBe(0);
    expect(JSON.parse(answering.out())).toEqual({ address: "http://127.0.0.1:7433", answering: true, environment: document });

    const silent = cli(stubFetch(refused).fetch);
    expect(await runCli(["status", "--json"], silent.context)).toBe(3);
    expect(JSON.parse(silent.out())).toEqual({ address: "http://127.0.0.1:7433", answering: false });
  });

  it("prints its usage and exits 2 on arguments it cannot parse", async () => {
    for (const args of [["status", "--port", "0"], ["status", "--port", "x"], ["status", "extra"], ["status", "--data-dir", "/x"]]) {
      const run = cli(stubFetch(refused).fetch);
      expect(await runCli(args, run.context), args.join(" ")).toBe(2);
      expect(run.err()).toContain("agent-harness status [--port <n>] [--json]");
    }
  });

  it("reports a real environment started on a free port", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-harness-status-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const env = await startEnvironment({
      dataDir,
      port: 0,
      name: "status-test",
      user: { isPrivileged: () => false },
      launcher: { prepared: () => undefined, close: () => undefined, present: () => false, onQuery: () => undefined, request: () => Promise.resolve(NO_LAUNCHER) },
    });
    cleanups.push(() => env.close());

    const run = cli(globalThis.fetch);
    expect(await runCli(["status", "--port", String(env.address.port)], run.context)).toBe(0);
    expect(run.out()).toContain(`Environment: status-test (${env.id})\n`);
    expect(run.out()).toContain("Readiness: ready\n");
  });
});
