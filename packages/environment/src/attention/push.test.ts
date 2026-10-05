import { createECDH, randomBytes, hkdfSync, createDecipheriv, createPublicKey, verify } from "node:crypto";
import { expect, it } from "vitest";
import { createPushTransport, pushEndpointAllowed } from "./push.js";
import { manualClock } from "../../test/clock.js";

const browser = createECDH("prime256v1");
browser.generateKeys();
const auth = randomBytes(16);
const target = { id: "phone", transport: "push", enabled: true, completion: false, configuration: { endpoint: "https://fcm.googleapis.com/fcm/send/test-registration", p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } as const;
const payload = { message: "A session needs you", url: "https://example.test:8443/#/session/env-1/session-1" } as const;
const clock = manualClock();
const entries = new Map<string, string>();
const vault = { get: async (key: string) => entries.get(key), set: async (key: string, value: string) => { entries.set(key, value); }, delete: async (key: string) => { entries.delete(key); }, keys: async () => [...entries.keys()] };

it("encrypts the safe payload for the browser and signs VAPID with the persistent environment key", async () => {
  let captured!: { body: Buffer; headers: Record<string, string> };
  const transport = await createPushTransport({ vault, clock, subject: "https://example.test:8443", post: async (_url, body, headers) => { captured = { body, headers }; return 201; } });
  expect(await transport.send({ id: "delivery-1", target, payload, signal: new AbortController().signal })).toEqual({ status: "sent" });
  const salt = captured.body.subarray(0, 16);
  expect(captured.body.readUInt32BE(16)).toBe(4096);
  const server = captured.body.subarray(21, 21 + captured.body[20]!);
  const ikm = hkdfSync("sha256", browser.computeSecret(server), auth, Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), server]), 32);
  const key = hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const encrypted = captured.body.subarray(21 + server.length);
  const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  expect(plaintext.at(-1)).toBe(2);
  expect(JSON.parse(plaintext.subarray(0, -1).toString())).toEqual(payload);
  expect(captured.headers["Content-Encoding"]).toBe("aes128gcm");
  const authorization = captured.headers["Authorization"]!;
  const jwt = authorization.match(/t=([^,]+)/)![1]!;
  const [header, claims, signature] = jwt.split(".");
  const publicKey = Buffer.from(transport.publicKey, "base64url");
  expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://example.test:8443" });
  expect((await createPushTransport({ vault, clock, subject: "https://example.test:8443" })).publicKey).toBe(transport.publicKey);
});

it.each(["http://fcm.googleapis.com/fcm/send/x", "https://localhost/push", "https://127.0.0.1/push", "https://fcm.googleapis.com.evil.test/fcm/send/x", "https://fcm.googleapis.com:8443/fcm/send/x", "https://@fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com/fcm/send/x#token", "https://example.test/push"])("refuses arbitrary and private push targets: %s", endpoint => expect(pushEndpointAllowed(endpoint)).toBe(false));
it.each(["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/Qx-test", "https://web.push.apple.com/Qx/test"])("accepts supported HTTPS vendor targets: %s", endpoint => expect(pushEndpointAllowed(endpoint)).toBe(true));
it.each([[404, "retire"], [410, "retire"], [503, "retry"], [307, "retry"]] as const)("handles gateway status %i as %s", async (status, outcome) => {
  const transport = await createPushTransport({ vault, clock, subject: "https://example.test", post: async () => status });
  expect(await transport.send({ id: "delivery", target, payload, signal: new AbortController().signal })).toEqual({ status: outcome });
});
it("refuses malformed subscription keys and unsafe payloads before the network", async () => {
  const transport = await createPushTransport({ vault, clock, subject: "https://example.test", post: async () => { throw new Error("Unexpected network"); } });
  expect(transport.validate({ ...target, configuration: { ...target.configuration, auth: "token-for-tests" } })).toBeTruthy();
});

it("cancels a hanging gateway at ten seconds using the environment clock", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transport = await createPushTransport({ vault, clock, subject: "https://example.test", post: async (_url, _body, _headers, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }); started(); }) });
  const pending = transport.send({ id: "delivery", target, payload, signal: new AbortController().signal });
  await ready;
  clock.advance(10_000);
  expect(await pending).toEqual({ status: "retry" });
});
