import { request as httpRequest } from "node:http";
import { BOOTSTRAP_PATH, GIT_CREDENTIAL_PATH, PAIR_PATH, PROTOCOL_VERSION, WIRE_PATH, type EventEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { EXCHANGE_RATE } from "../auth/rate-limit.js";

const { onCleanup } = useCleanups();

/** The external HTTPS origin Tailscale Serve answers on, proxying to the environment's loopback port. */
const WEB_ORIGIN = "https://web.example:8443";
const WEB_HOST = "web.example:8443";

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ webOrigin: WEB_ORIGIN });
  onCleanup(() => t.close());
  return t;
};

/** Posts `body` to `path` over loopback with the headers a proxy in front of the environment would send. */
const post = (t: TestEnvironment, path: string, headers: Record<string, string>, body: unknown): Promise<number> =>
  new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const sent = httpRequest(
      { host: t.address.host, port: t.address.port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });

/** Opens the wire with `headers` and authenticates as `token`, resolving once `hello` arrives. */
const connect = (t: TestEnvironment, token: string, headers: Record<string, string>): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${t.address.host}:${t.address.port}${WIRE_PATH}`, { headers });
    onCleanup(() => ws.close());
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, protocolVersion: PROTOCOL_VERSION, clientKind: "program", harnessVersion: "0.0.0-test" })));
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "hello") resolve(ws);
      else if (frame.type === "bye") reject(new Error(`The wire said bye: ${data.toString()}`));
    });
    ws.on("error", reject);
  });

const opened = async (t: TestEnvironment, clientSessionId: string): Promise<Record<string, unknown>[]> => {
  const admin = await t.client();
  const { events } = await admin.request("access.log.list", { afterSequence: 0, limit: 1000 });
  return events
    .filter((event: EventEnvelope) => event.type === "socket.opened" && event.payload["clientSessionId"] === clientSessionId)
    .map((event: EventEnvelope) => event.payload);
};

describe("a client behind the HTTPS proxy", () => {
  it("is logged with the address and Tailscale login the proxy forwarded, and without them as the peer it is", async () => {
    const t = await start();
    const phone = await t.pair({ label: "phone" });
    await connect(t, phone.token, { host: WEB_HOST, "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "owner@example.test" });
    await connect(t, phone.token, { host: WEB_HOST });
    await connect(t, phone.token, { host: `127.0.0.1:${t.address.port}`, "x-forwarded-for": "100.64.0.8" });
    expect(await opened(t, phone.clientSessionId)).toEqual([
      { clientSessionId: phone.clientSessionId, socketId: expect.any(String), remoteAddress: "100.64.0.7", login: "owner@example.test" },
      { clientSessionId: phone.clientSessionId, socketId: expect.any(String), remoteAddress: "127.0.0.1" },
      { clientSessionId: phone.clientSessionId, socketId: expect.any(String), remoteAddress: "127.0.0.1" },
    ]);
  });

  it("spends each forwarded address's own pairing rate-limit bucket", async () => {
    const t = await start();
    const wrong = { code: "WRONGCODE", kind: "program", label: "phone", protocolVersion: PROTOCOL_VERSION };
    const from = (address: string) => ({ host: WEB_HOST, "x-forwarded-for": address });
    for (let index = 0; index < EXCHANGE_RATE.capacity; index++) expect(await post(t, PAIR_PATH, from("100.64.0.7"), wrong)).not.toBe(429);
    expect(await post(t, PAIR_PATH, from("100.64.0.7"), wrong)).toBe(429);
    expect(await post(t, PAIR_PATH, from("100.64.0.8"), wrong)).not.toBe(429);
    expect(await post(t, PAIR_PATH, { host: WEB_HOST }, wrong)).not.toBe(429);
  });

  it("is refused the bootstrap exchange, which answers loopback clients only", async () => {
    const t = await start();
    const body = { secret: t.grant().secret, kind: "tui", label: "proxied" };
    expect(await post(t, BOOTSTRAP_PATH, { host: WEB_HOST, "x-forwarded-for": "100.64.0.7" }, body)).toBe(403);
    expect(await post(t, BOOTSTRAP_PATH, { host: WEB_HOST }, body)).toBe(200);
  });

  it("is refused the git credential route, which answers loopback clients only", async () => {
    const t = await start();
    const body = { protocol: "https", host: "forge.example.test" };
    expect(await post(t, GIT_CREDENTIAL_PATH, { host: WEB_HOST, "x-forwarded-for": "100.64.0.7" }, body)).toBe(403);
    expect(await post(t, GIT_CREDENTIAL_PATH, { host: WEB_HOST }, body)).not.toBe(403);
  });
});
