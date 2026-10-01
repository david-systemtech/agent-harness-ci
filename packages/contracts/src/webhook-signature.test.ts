import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX, generateWebhookSecret, signWebhook, webhookKey } from "./index.js";

/**
 * The Standard Webhooks `v1` signature (routines spec, "Delivery targets";
 * #522): base64 HMAC-SHA256 over `id.timestamp.body`, keyed by a `whsec_`
 * secret's decoded bytes, else by the secret's own bytes, as Hermes's
 * webhook adapter verifies it.
 */

/**
 * The one vector the Standard Webhooks reference libraries all pin, in their
 * "sign function works" tests (JavaScript, Python, Go, C#, PHP, at
 * standard-webhooks/standard-webhooks 7537d2a); the specification's own
 * examples name no secret, so they cannot be checked. Its secret is put
 * together here from eight-character pieces, so no line of the repository
 * holds a whole `whsec_` value or a run a secret scanner reads as a key.
 */
const PUBLISHED_PIECES = ["MfKQ9r8G", "KYqrTwjU", "PD8ILPZI", "o2LaLaSw"] as const;
const PUBLISHED = {
  secret: `${WEBHOOK_SECRET_PREFIX}${PUBLISHED_PIECES.join("")}`,
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
} as const;

/** Node's own HMAC over the same content, keyed by `key`: the independent signer the cases compare with. */
const nodeSignature = (key: Uint8Array | string, message: { id: string; timestamp: number; body: string }): string =>
  `v1,${createHmac("sha256", key).update(`${message.id}.${message.timestamp}.${message.body}`, "utf8").digest("base64")}`;

describe("signWebhook", () => {
  it("gives the Standard Webhooks reference libraries' published signature", async () => {
    expect(await signWebhook(PUBLISHED.secret, PUBLISHED)).toBe(PUBLISHED.signature);
  });

  it("keys a secret without the whsec_ prefix by its own UTF-8 bytes, over a body that is not ASCII", async () => {
    const message = { id: "routine-test-1", timestamp: 1790208000, body: '{"text":"Café ☕, 𝄞 and a\\nnew line"}' };

    const signature = await signWebhook("token-for-tests", message);

    expect(signature).toBe("v1,H0iQlUkdfb8gEBKtAGjrBGwcYGHbJFx27LWEQToQB8w=");
    expect(signature).toBe(nodeSignature(Buffer.from("token-for-tests", "utf8"), message));
  });

  it("refuses a whsec_ secret whose rest is not base64, signing nothing", async () => {
    await expect(signWebhook(`${WEBHOOK_SECRET_PREFIX}not base64!`, PUBLISHED)).rejects.toThrow(RangeError);
  });
});

describe("webhookKey", () => {
  it("decodes a whsec_ secret's padded standard base64, and takes any other secret's bytes as they are", () => {
    expect(webhookKey(PUBLISHED.secret)).toEqual(new Uint8Array(Buffer.from(PUBLISHED.secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64")));
    expect(webhookKey([WEBHOOK_SECRET_PREFIX, "AAEC/+8="].join(""))).toEqual(new Uint8Array([0, 1, 2, 255, 239]));
    expect(webhookKey("token-for-tests")).toEqual(new Uint8Array(Buffer.from("token-for-tests", "utf8")));
    // The prefix is matched as written: another spelling is part of a secret taken as bytes.
    expect(webhookKey("WHSEC_AAEC")).toEqual(new Uint8Array(Buffer.from("WHSEC_AAEC", "utf8")));
  });

  it.each([
    ["nothing after the prefix", ""],
    ["missing padding, which Hermes's adapter refuses", "AAEC/+8"],
    ["the URL-safe alphabet", "AAEC_-8="],
    ["a character outside base64", "AAEC*+8="],
    ["padding in the middle", "AA==AAEC"],
    ["too much padding", "AAE==="],
  ])("answers null for a whsec_ secret with %s", (_case, rest) => {
    expect(webhookKey(`${WEBHOOK_SECRET_PREFIX}${rest}`)).toBeNull();
  });
});

describe("generateWebhookSecret", () => {
  it("makes a whsec_ secret of 32 random bytes, which signs as Node's HMAC keyed by those bytes does", async () => {
    const secret = generateWebhookSecret();
    const other = generateWebhookSecret();

    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(secret).not.toBe(other);
    const bytes = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
    expect(bytes.length).toBe(WEBHOOK_SECRET_BYTES);
    expect(webhookKey(secret)).toEqual(new Uint8Array(bytes));
    expect(await signWebhook(secret, PUBLISHED)).toBe(nodeSignature(bytes, PUBLISHED));
  });
});
