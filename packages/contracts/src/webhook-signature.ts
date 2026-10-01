/**
 * The Standard Webhooks `v1` signature a webhook endpoint's POST carries in
 * `webhook-signature` (routines spec, "Delivery targets"; #522): `v1,`
 * then the base64 HMAC-SHA256 over the delivery's id, its timestamp and its
 * body joined by dots, keyed by the endpoint's secret. A `whsec_` secret
 * keys it with the bytes its base64 decodes to, any other secret with its
 * own UTF-8 bytes, as Hermes's webhook adapter verifies it. Pure, over the
 * platform's Web Crypto, which every environment and client has as
 * `globalThis.crypto`; a client generates a `whsec_` secret here, to paste
 * into both ends.
 */

/** The part of the Web Crypto API the signature uses. */
interface WebCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: {
    importKey(
      format: "raw",
      keyData: Uint8Array,
      algorithm: { readonly name: "HMAC"; readonly hash: "SHA-256" },
      extractable: false,
      keyUsages: readonly "sign"[],
    ): Promise<object>;
    sign(algorithm: "HMAC", key: object, data: Uint8Array): Promise<ArrayBuffer>;
  };
}

/** The platform's Web Crypto and UTF-8 encoder, which the contracts' ES library types do not declare. */
const platform = globalThis as unknown as { readonly crypto: WebCrypto; readonly TextEncoder: new () => { encode(text: string): Uint8Array } };

/** What marks a secret as Standard Webhooks' serialization: the prefix, then the key's bytes in base64. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/** How many random bytes a generated secret has: Standard Webhooks asks for 24 to 64. */
export const WEBHOOK_SECRET_BYTES = 32;

/** The signature scheme's identifier, before the comma: symmetric HMAC-SHA256. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/** What a signature covers: the delivery's id, its timestamp in whole seconds since the epoch, and the body exactly as sent. */
export interface WebhookMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly body: string;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with its padding: whole groups of four, the last ending in `=` or `==` when the bytes do not fill it. */
const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const [first = 0, second, third] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    text += BASE64.charAt(group >> 18) + BASE64.charAt((group >> 12) & 63);
    text += second === undefined ? "=" : BASE64.charAt((group >> 6) & 63);
    text += third === undefined ? "=" : BASE64.charAt(group & 63);
  }
  return text;
};

/** The bytes padded standard base64 decodes to; null for anything else, as Hermes's adapter refuses it. */
const fromBase64 = (text: string): Uint8Array | null => {
  if (!PADDED_BASE64.test(text)) return null;
  const digits = text.replace(/=+$/, "");
  const bytes = new Uint8Array((digits.length * 3) >> 2);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const digit of digits) {
    held = ((held << 6) | BASE64.indexOf(digit)) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (held >> bits) & 0xff;
    }
  }
  return bytes;
};

/**
 * The key a secret signs with: a `whsec_` secret's decoded bytes, any
 * other secret's UTF-8 bytes. Null when there is no key: a `whsec_` secret
 * whose rest is not padded standard base64, or a secret that comes to no
 * bytes.
 */
export const webhookKey = (secret: string): Uint8Array | null => {
  const key = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? fromBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length)) : new platform.TextEncoder().encode(secret);
  return key === null || key.length === 0 ? null : key;
};

/** A `webhook-timestamp`: the instant in whole seconds since the epoch. */
export const webhookTimestamp = (at: Date): number => Math.floor(at.getTime() / 1000);

/**
 * The `webhook-signature` for `message` under `secret`: `v1,` and the
 * base64 HMAC-SHA256 over `id.timestamp.body`. Rejects with a `RangeError`
 * when the secret gives no key (`webhookKey`).
 */
export const signWebhook = async (secret: string, message: WebhookMessage): Promise<string> => {
  const key = webhookKey(secret);
  if (key === null) throw new RangeError(`The secret gives no key: a ${WEBHOOK_SECRET_PREFIX} secret is the prefix and its key in padded standard base64.`);
  const { subtle } = platform.crypto;
  const hmac = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await subtle.sign("HMAC", hmac, new platform.TextEncoder().encode(`${message.id}.${message.timestamp}.${message.body}`));
  return `${WEBHOOK_SIGNATURE_VERSION},${toBase64(new Uint8Array(signature))}`;
};

/** A new `whsec_` secret: 32 random bytes from the platform's Web Crypto, in padded standard base64 after the prefix. */
export const generateWebhookSecret = (): string =>
  `${WEBHOOK_SECRET_PREFIX}${toBase64(platform.crypto.getRandomValues(new Uint8Array(WEBHOOK_SECRET_BYTES)))}`;
