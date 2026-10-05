import { EventEmitter } from "node:events";
import { createECDH, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { LookupFunction } from "node:net";
import { manualClock } from "../../test/clock.js";
const network = vi.hoisted(() => ({ resolve: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.resolve }));
vi.mock("node:https", () => ({ request: network.request }));
import { createPushTransport } from "./push.js";

const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
const target = { id: "phone", transport: "push", enabled: true, completion: false, configuration: { endpoint: "https://fcm.googleapis.com/fcm/send/test", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } } as const;
const payload = { message: "A session needs you", url: "https://example.test/#/session/env-1/session-1" } as const;
const vault = { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] };

it.each(["timeout", "cancel"])("releases a stalled DNS lookup on %s without opening a socket", async reason => {
  let finish!: (addresses: { address: string; family: number }[]) => void;
  network.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  network.request.mockClear().mockImplementation(() => { throw new Error("Unexpected socket after abort"); });
  const clock = manualClock();
  const caller = new AbortController();
  const transport = await createPushTransport({ vault, clock, subject: "https://example.test" });
  let result: unknown;
  const sending = transport.send({ id: "delivery", target, payload, signal: caller.signal }).then(value => { result = value; });
  if (reason === "timeout") clock.advance(10_000); else caller.abort();
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(result).toEqual({ status: "retry" });
    expect(clock.pending()).toBe(0);
    expect(network.request).not.toHaveBeenCalled();
  } finally { finish([{ address: "93.184.216.34", family: 4 }]); await sending; }
  expect(network.request).not.toHaveBeenCalled();
});

it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "::ffff:127.0.0.1"])("refuses a supported vendor name resolving to %s before opening a socket", async address => {
  network.request.mockClear();
  network.resolve.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
  const transport = await createPushTransport({ vault, clock: manualClock(), subject: "https://example.test" });
  expect(await transport.send({ id: "delivery", target, payload, signal: new AbortController().signal })).toEqual({ status: "retry" });
  expect(network.request).not.toHaveBeenCalled();
});
it("pins the vetted public DNS answer for both single-address and all-address lookups", async () => {
  const address = { address: "93.184.216.34", family: 4 };
  network.resolve.mockResolvedValue([address]);
  let lookup!: LookupFunction;
  network.request.mockImplementation((_endpoint: string, options: { lookup: LookupFunction }, response: (value: { statusCode: number; destroy(): void }) => void) => {
    lookup = options.lookup;
    return Object.assign(new EventEmitter(), { end: () => response({ statusCode: 201, destroy: () => undefined }) });
  });
  const transport = await createPushTransport({ vault, clock: manualClock(), subject: "https://example.test" });
  expect(await transport.send({ id: "delivery", target, payload, signal: new AbortController().signal })).toEqual({ status: "sent" });
  const single = vi.fn(); lookup("fcm.googleapis.com", {}, single);
  expect(single).toHaveBeenCalledWith(null, address.address, 4);
  const all = vi.fn(); lookup("fcm.googleapis.com", { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [address]);
});
