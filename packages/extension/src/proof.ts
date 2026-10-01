/**
 * The proof of a pairing's secret on a challenge's nonce (bridge protocol
 * version 2, `BridgeProof`): HMAC-SHA256 of the nonce as sent, its UTF-8
 * bytes, keyed by the secret's 32 bytes (not its characters), in lowercase
 * hex. Web Crypto's, which a service worker has and Node's tests do too.
 */

const bytesOfHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const hexOf = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const proofOf = async (secret: string, nonce: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", bytesOfHex(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce)));
};
