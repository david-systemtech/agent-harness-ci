import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  Ceiling,
  ContractError,
  HelloFrame,
  PROTOCOL_VERSION,
  SCOPES,
  OWED_HANDLERS,
  methods,
  type ClientSessionCredential,
  type Frame,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import WebSocketClient from "ws";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ByeError, connectClient, openSocket, wireUrl } from "../../test/wire-client.js";
import type { Address } from "../serve/http.js";
import { presetColour } from "../look/look.js";
import type { StartupStep } from "../serve/start.js";
import { AUTH_TIMEOUT_MS, PING_INTERVAL_MS } from "./wire.js";

const { onCleanup, tempDir } = useCleanups();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** A test environment, closed after the test. */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A client session issued through the handle's in-process pairing: here, to hold fewer scopes. */
const issue = (t: TestEnvironment, scopes: readonly Scope[]): ClientSessionCredential =>
  t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") });

/** The error a request is refused with. */
const refusal = async (promise: Promise<unknown>): Promise<ContractError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ContractError)) throw new Error(`expected a ContractError, got ${String(error)}`);
  return error;
};

/** The `bye` a refused authentication ends with. */
const byeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ByeError)) throw new Error(`expected a bye, got ${String(error)}`);
  return error.closed;
};

const authFrame = (token: string, protocolVersion: number = PROTOCOL_VERSION) => ({
  type: "auth",
  token,
  protocolVersion,
  clientKind: "tui",
  harnessVersion: "0.0.0-test",
});

/** Hooks that hold startup before `step` until released, reporting the address bound so far. */
const holdBefore = (step: StartupStep) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: (address: Address | undefined) => void;
  const reached = new Promise<Address | undefined>((resolve) => (reach = resolve));
  return {
    hooks: {
      beforeStep: async (current: StartupStep, progress: { readonly address: Address | undefined }) => {
        if (current !== step) return;
        reach(progress.address);
        await gate;
      },
    },
    reached,
    release,
  };
};

/** An upgrade to `path` with our own Host header, which Node's WebSocket does not allow: the status it is refused with, or 101. */
const upgradeStatus = (address: Address, path: string, host?: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = new WebSocketClient(`ws://${address.host}:${address.port}${path}`, {
      ...(host !== undefined && { headers: { host } }),
    });
    socket.on("open", () => {
      socket.close();
      resolve(101);
    });
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on("error", reject);
  });

describe("the WebSocket", () => {
  it("is at /ws, on the same listener, behind the same Host check", async () => {
    const t = await start();
    expect(await upgradeStatus(t.address, "/ws")).toBe(101);
    expect(await upgradeStatus(t.address, "/ws", `localhost:${t.address.port}`)).toBe(101);
    expect(await upgradeStatus(t.address, "/ws", "evil.example")).toBe(421);
    expect(await upgradeStatus(t.address, "/elsewhere")).toBe(404);
  });

  it("refuses a URL with a query, so no token is ever accepted from one", async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    expect(await upgradeStatus(t.address, `/ws?token=${encodeURIComponent(token)}`)).toBe(400);
    expect(await upgradeStatus(t.address, "/ws?x=1")).toBe(400);
  });

  it("is reached by the test client with the bare wire path, the token only in auth", async () => {
    const t = await start();
    const urls: string[] = [];
    const Native = globalThis.WebSocket;
    vi.stubGlobal(
      "WebSocket",
      class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          urls.push(String(url));
          super(url, protocols);
        }
      },
    );
    onCleanup(() => void vi.unstubAllGlobals());
    const credential = await t.bootstrap();
    const client = await t.client({ token: credential.token });
    expect(client.hello.clientSessionId).toBe(credential.clientSessionId);
    expect(urls).toEqual([`ws://127.0.0.1:${t.address.port}/ws`]);
    expect(urls.join()).not.toContain(credential.token);
  });

  it("answers a plain GET at /ws with 426, since it is not an upgrade", async () => {
    const t = await start();
    const response = await fetch(`http://${t.address.host}:${t.address.port}/ws`);
    expect(response.status).toBe(426);
  });
});

describe("auth and hello", () => {
  it("answers a valid auth with hello: protocol, capabilities, environment, client session, scopes, ceiling, server time", async () => {
    const t = await start({ name: "desk", platform: "darwin" });
    t.clock.advance(5 * MINUTE);
    const credential = await t.bootstrap("tui");
    const client = await t.client({ token: credential.token });
    expect(HelloFrame.parse(client.hello)).toEqual(client.hello);
    expect(client.hello).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      // The forge accounts (#310), the key-manager connections (#365), the Managed tools registry (#373), file undo (#1183),
      // the Workspace checks (#1187), the bank registry (#1025), Set up's results (#569) and the state import's run (#1165);
      // the containment flags only where the probe found a level enforceable.
      capabilities: ["forge", "keyManagers", "managedTools", "fileUndo", "workspaceChecks", "banks", "setup", "stateImport"],
      environmentId: t.env.id,
      environmentName: "desk",
      // Its icon and colour (#323), which until set are the platform's and a hash of its id's.
      environmentIcon: "laptop",
      environmentColour: presetColour(t.env.id),
      clientSessionId: credential.clientSessionId,
      scopes: [...SCOPES],
      ceiling: "bypassPermissions",
      serverTime: t.clock.now().toISOString(),
    });
    expect(client.received[0]).toEqual(client.hello);
  });

  it("names the client session's own scopes and ceiling", async () => {
    const t = await start();
    const credential = issue(t, ["read", "runs:drive"]);
    const client = await t.client({ token: credential.token, clientKind: "program" });
    expect(client.hello).toMatchObject({ clientSessionId: credential.clientSessionId, scopes: ["read", "runs:drive"], ceiling: "acceptEdits" });
  });

  it("then answers requests", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });

  it("lets one client session hold several sockets", async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    const one = await t.client({ token });
    const two = await t.client({ token });
    expect(await one.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    expect(await two.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });
});

describe("bye", () => {
  it("protocol: a version the environment does not speak, naming both, before the token is looked at", async () => {
    const t = await start();
    for (const version of [1, PROTOCOL_VERSION + 1, 99]) {
      const closed = await byeOf(t.client({ token: "not even a token", protocolVersion: version }));
      expect(closed.bye).toMatchObject({ type: "bye", reason: "protocol", protocolVersion: PROTOCOL_VERSION });
      expect(closed.bye?.message).toContain(String(version));
      expect(closed.bye?.message).toContain(String(PROTOCOL_VERSION));
    }
  });

  it("protocol: even when the rest of the auth frame is in a shape this version does not know", async () => {
    const t = await start();
    const socket = await t.open();
    socket.send({ type: "auth", protocolVersion: PROTOCOL_VERSION + 1, credentials: { bearer: "x" } });
    expect((await socket.closed).bye).toMatchObject({ reason: "protocol", protocolVersion: PROTOCOL_VERSION });
  });

  it("unauthorized: an invalid token", async () => {
    const t = await start();
    for (const token of ["garbage", "v1.e30.c2ln", "a.b.c.d", "v1..", "v1.%%%.***"]) {
      const closed = await byeOf(t.client({ token }));
      expect(closed.bye?.reason, token).toBe("unauthorized");
    }
  });

  it("unauthorized: a token altered after it was issued", async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    const [version, payload, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const other = issue(t, ["read"]);
    const forged = Buffer.from(JSON.stringify({ ...claims, sid: other.clientSessionId })).toString("base64url");
    expect((await byeOf(t.client({ token: `${version}.${forged}.${signature}` }))).bye?.reason).toBe("unauthorized");
  });

  it("unauthorized: a foreign token, issued by another environment", async () => {
    const here = await start();
    const there = await start();
    const { token } = await there.bootstrap();
    expect((await byeOf(here.client({ token }))).bye?.reason).toBe("unauthorized");
    expect((await there.client({ token })).hello.environmentId).toBe(there.env.id);
  });

  it("unauthorized: a token this environment signed but does not know, its client sessions lost", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const { token } = await first.bootstrap();
    await first.close();
    rmSync(join(dataDir, "environment.db"));

    const second = await start({ dataDir });
    expect(second.env.id).toBe(first.env.id);
    expect((await byeOf(second.client({ token }))).bye?.reason).toBe("unauthorized");
  });

  it("unauthorized: a first frame that is not auth", async () => {
    const t = await start();
    for (const first of [
      { type: "request", id: "1", method: "environment.status", params: {} },
      { type: "pong" },
      "not json",
      { type: "auth", protocolVersion: PROTOCOL_VERSION, clientKind: "tui", harnessVersion: "1" },
    ]) {
      const socket = await t.open();
      socket.send(first);
      const closed = await socket.closed;
      expect(closed.bye?.reason, JSON.stringify(first)).toBe("unauthorized");
      expect(socket.received.filter((frame) => frame.type !== "bye")).toEqual([]);
    }
  });

  it(`unauthorized: no auth within ${AUTH_TIMEOUT_MS / SECOND} seconds`, async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    const slow = await t.open();
    t.clock.advance(AUTH_TIMEOUT_MS - 1);
    slow.send(authFrame(token));
    expect(await slow.next((f) => f.type === "hello" || f.type === "bye")).toMatchObject({ type: "hello" });

    const silent = await t.open();
    t.clock.advance(AUTH_TIMEOUT_MS);
    expect((await silent.closed).bye?.reason).toBe("unauthorized");
  });

  it("expired: a token past its 30 days", async () => {
    const t = await start({ dataDir: join(tempDir(), "data") });
    // A desktop client session, since a tui one left unconnected is revoked after an hour.
    const credential = await t.bootstrap("desktop");
    expect(Date.parse(credential.expiresAt) - t.clock.now().getTime()).toBe(30 * DAY);

    // Closed across the days, so none of its timers run through them (#783).
    const again = await restartAfter(t, 30 * DAY - 1, start);
    const lastMoment = await again.client({ token: credential.token, clientKind: "desktop" });
    await lastMoment.close();
    again.clock.advance(1);
    expect((await byeOf(again.client({ token: credential.token, clientKind: "desktop" }))).bye?.reason).toBe("expired");
  });

  it("expired: at the first ping after the token expires on an open socket", async () => {
    const t = await start({ dataDir: join(tempDir(), "data") });
    const credential = await t.bootstrap("desktop");
    // Closed across the days, so none of its timers run through them (#783); started again for the last pings.
    const again = await restartAfter(t, 30 * DAY - 20 * SECOND, start);
    const client = await again.client({ token: credential.token, clientKind: "desktop" });
    again.clock.advance(PING_INTERVAL_MS);
    await client.next((f) => f.type === "ping");
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    again.clock.advance(PING_INTERVAL_MS);
    expect((await client.closed).bye?.reason).toBe("expired");
  });

  it("revoked: an open socket when its client session is revoked, and its token from then on", async () => {
    const t = await start();
    const credential = issue(t, ["read"]);
    const client = await t.client({ token: credential.token });
    expect(t.env.clientSessions.revoke(credential.clientSessionId)).toBe(true);
    const closed = await client.closed;
    expect(closed.bye?.reason).toBe("revoked");
    expect((await byeOf(t.client({ token: credential.token }))).bye?.reason).toBe("revoked");
    expect(t.env.clientSessions.revoke(credential.clientSessionId)).toBe(false);
  });

  it("revoked: a revocation survives a restart", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const credential = issue(first, ["read"]);
    first.env.clientSessions.revoke(credential.clientSessionId);
    await first.close();

    const second = await start({ dataDir });
    expect((await byeOf(second.client({ token: credential.token }))).bye?.reason).toBe("revoked");
  });
});

describe("before the startup gate", () => {
  it("answers a request unavailable, holds auth until the gate, then answers it with hello", async () => {
    const dataDir = join(tempDir(), "data");
    const earlier = await startTestEnvironment({ dataDir });
    const { token } = await earlier.bootstrap();
    await earlier.close();

    const hold = holdBefore("prepared");
    const starting = startTestEnvironment({ dataDir, hooks: hold.hooks });
    onCleanup(async () => {
      hold.release();
      await (await starting).close();
    });
    const address = await hold.reached;
    if (!address) throw new Error("the listener was not bound before the prepared step");

    const early = await openSocket(address);
    early.send({ type: "request", id: "before-auth", method: "environment.status", params: {} });
    expect(await early.next((f) => f.type === "response")).toEqual({
      type: "response",
      id: "before-auth",
      error: { code: "unavailable", message: expect.any(String), data: { readiness: "starting" } },
    });
    early.send(authFrame(token));
    early.send({ type: "request", id: "after-auth", method: "access.sessions.list", params: {} });
    expect(await early.next((f) => f.type === "response")).toMatchObject({
      id: "after-auth",
      error: { code: "unavailable", data: { readiness: "starting" } },
    });
    expect(early.received.some((frame) => frame.type === "hello")).toBe(false);

    hold.release();
    await starting;
    const hello = await early.next((f) => f.type === "hello");
    expect(hello).toMatchObject({ type: "hello" });
    early.send({ type: "request", id: "ready", method: "environment.status", params: {} });
    expect(await early.next((f) => f.type === "response")).toMatchObject({ type: "response", id: "ready", result: { readiness: "ready" } });
    await early.close();
  });
});

describe("the scope check", () => {
  it("refuses a method whose scope the client session lacks, forbidden, naming the scope", async () => {
    const t = await start();
    const client = await t.client({ token: issue(t, ["read"]).token });
    const error = await refusal(client.request("access.sessions.list", {}));
    expect(error.toWire()).toEqual({ code: "forbidden", message: expect.stringContaining("admin"), data: { scope: "admin" } });
  });

  it("refuses a stream the same way", async () => {
    const t = await start();
    const client = await t.client({ token: issue(t, ["admin"]).token });
    const error = await refusal(client.request("environment.subscribe", { afterSequence: 0 }));
    expect(error.toWire()).toMatchObject({ code: "forbidden", data: { scope: "read" } });
  });

  it("comes before the params are read", async () => {
    const t = await start();
    const client = await t.client({ token: issue(t, ["read"]).token });
    const answer = await client.call("environment.drain", { commandId: "not a uuid", extra: [1, 2] });
    expect(answer).toMatchObject({ type: "response", error: { code: "forbidden", data: { scope: "admin" } } });
  });

  it("lets a method through when the client session holds its scope", async () => {
    const t = await start();
    const client = await t.client({ token: issue(t, ["read"]).token });
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });
});

describe("requests", () => {
  it("answers an unknown method not_found", async () => {
    const t = await start();
    const client = await t.client();
    const answer = await client.call("nothing.here", {});
    expect(answer).toMatchObject({ type: "response", error: { code: "not_found", data: {} } });
  });

  it("answers params that do not match the method's schema invalid_params, with the issues", async () => {
    const t = await start();
    const client = await t.client();
    const answer = await client.call("access.log.list", { limit: 0 });
    expect(answer).toMatchObject({
      type: "response",
      error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["limit"] })] } },
    });
  });

  it("answers a malformed request that has an id invalid_params, and keeps the socket", async () => {
    const t = await start();
    const client = await t.client();
    client.send({ type: "request", id: "bad", method: "environment.status", params: [] });
    expect(await client.next((f) => f.type === "response")).toMatchObject({
      id: "bad",
      error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["params"] })] } },
    });
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });

  it("says bye protocol, naming the fault, and closes 1002, on a malformed frame with no id to answer", async () => {
    const t = await start();
    for (const frame of ["{ not json", JSON.stringify({ type: "request", method: "environment.status", params: {} }), "[]"]) {
      const client = await t.client();
      client.send(frame);
      const closed = await client.closed;
      expect(closed.code, frame).toBe(1002);
      expect(closed.bye, frame).toMatchObject({ reason: "protocol", message: expect.stringContaining("malformed") });
    }
  });

  it("says bye protocol and closes 1003 on a binary frame", async () => {
    const t = await start();
    const client = await t.client();
    client.send(new TextEncoder().encode(JSON.stringify({ type: "request", id: "1", method: "environment.status", params: {} })));
    const closed = await client.closed;
    expect(closed.code).toBe(1003);
    expect(closed.bye).toMatchObject({ reason: "protocol", message: expect.stringContaining("text") });
  });

  it("says bye protocol and closes 1002 on a frame kind a client does not send, a second auth included", async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    for (const frame of [authFrame(token), { type: "ping" }, { type: "bye", reason: "draining" }, { type: "subscribed", id: "1", subscription: "s" }]) {
      const client = await t.client();
      client.send(frame);
      const closed = await client.closed;
      expect(closed.code, frame.type).toBe(1002);
      expect(closed.bye, frame.type).toMatchObject({ reason: "protocol", message: expect.stringContaining(frame.type) });
    }
  });

  it("answers a stream method, once its scope is held, with subscribed rather than a response", async () => {
    const t = await start();
    const client = await t.client();
    const answer = await client.call("environment.subscribe", { afterSequence: 0 });
    expect(answer).toEqual({ type: "subscribed", id: expect.any(String), subscription: expect.any(String) });
  });

  it("serves every registered method or owes it to a named ticket, and owes none it serves (dispatch.test.ts covers one without a handler)", async () => {
    const t = await start();
    const unserved = methods.filter((method) => t.env.methods.get(method.name)?.handler === undefined).map((method) => method.name);
    // An unserved method missing from the list is unowed; a served one still on it is owed by mistake.
    expect(unserved.sort()).toEqual(Object.keys(OWED_HANDLERS).sort());
  });
});

describe("ping", () => {
  it(`is sent every ${PING_INTERVAL_MS / SECOND} seconds, and a pong is taken`, async () => {
    const t = await start();
    const client = await t.client();
    const pings = () => client.received.filter((frame) => frame.type === "ping").length;

    t.clock.advance(PING_INTERVAL_MS - 1);
    // Frames arrive in the order sent: a ping sent before this answer would be received before it.
    await client.request("environment.status", {});
    expect(pings()).toBe(0);

    t.clock.advance(1);
    await client.next((f) => f.type === "ping");
    t.clock.advance(PING_INTERVAL_MS);
    await client.next((f) => f.type === "ping");
    t.clock.advance(3 * PING_INTERVAL_MS);
    await client.request("environment.status", {});
    expect(pings()).toBe(5);
    expect(client.isOpen()).toBe(true);
  });

  it("never closes a socket that does not answer: the watchdog is the client's", async () => {
    const t = await start();
    const client = await t.client({ autoPong: false });
    t.clock.advance(10 * MINUTE);
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    expect(client.received.filter((frame: Frame) => frame.type === "ping")).toHaveLength(40);
  });

  it("stops when the socket closes", async () => {
    const t = await start();
    // The start pass's budgets are on the clock until Set up's checks answer (#571).
    await t.env.setup.startPass;
    const before = t.clock.pending();
    const client = await t.client();
    expect(t.clock.pending()).toBe(before + 1);
    await client.close();
    await vi.waitFor(() => expect(t.clock.pending()).toBe(before));
  });
});

describe("closing the environment", () => {
  it("says bye draining to every open socket, then closes each 1001", async () => {
    const t = await startTestEnvironment({ clock: manualClock() });
    const one = await t.client();
    const two = await t.client({ token: issue(t, ["read"]).token });
    const unauthenticated = await t.open();
    await t.env.close();
    for (const socket of [one, two, unauthenticated]) {
      const closed = await socket.closed;
      expect(closed.code).toBe(1001);
      expect(closed.bye).toMatchObject({ reason: "draining" });
    }
    await t.close();
  });
});

describe("the test client", () => {
  it("connects with connectClient to any address, as the helper does", async () => {
    const t = await start();
    const { token } = await t.bootstrap();
    const client = await connectClient(t.address, { token });
    onCleanup(() => client.close());
    expect(wireUrl(t.address)).toBe(`ws://127.0.0.1:${t.address.port}/ws`);
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });
});
