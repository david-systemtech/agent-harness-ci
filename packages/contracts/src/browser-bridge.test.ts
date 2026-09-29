import { createHash, createHmac, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_ENVIRONMENT_MESSAGE_TYPES,
  BRIDGE_EXTENSION_MESSAGE_TYPES,
  BRIDGE_MESSAGE_MAX_CHARS,
  BRIDGE_PROOF_TEST_VECTOR,
  BRIDGE_PROTOCOL_VERSION,
  EXTENSION_ID,
  EXTENSION_MANIFEST_KEY,
  EXTENSION_ORIGIN,
  PORT_FILE_NAME,
  PortFile,
  decodeFromEnvironment,
  decodeFromExtension,
  encodeBridgeMessage,
  serveBridgeVersion,
  type BridgeFromEnvironment,
  type BridgeFromExtension,
} from "./index.js";

/**
 * Bridge protocol version 2 between an environment and its extension
 * (browser spec, "The extension, its folder and its listener"; ADR 0024;
 * #541): its messages and their codec, the version rule, the proof and its
 * test vector, the port file, and the extension's fixed id.
 */

const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const policy = { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: [] };

const fromExtension: readonly BridgeFromExtension[] = [
  { type: "announce", protocolVersion: 2, extensionVersion: "0.4.2", name: "Work" },
  { type: "pair", code: "K7Q2MXH4", name: "Work" },
  { type: "hello", protocolVersion: 2, extensionVersion: "0.4.2", environmentId, chromeId, name: "Work" },
  { type: "proof", mac: BRIDGE_PROOF_TEST_VECTOR.proof },
  { type: "result", id: "call-1", result: { ok: true, value: { url: "https://example.com/", title: "Example" } } },
  { type: "result", id: "call-2", result: { ok: false, reason: "Take a new snapshot: that ref is from an older one." } },
  { type: "ping" },
  { type: "pong" },
  { type: "refused", reason: "Another environment holds this port." },
];

const fromEnvironment: readonly BridgeFromEnvironment[] = [
  { type: "announced", environmentId, environmentName: "SYSTEM-SERVER" },
  { type: "paired", chromeId, secret: BRIDGE_PROOF_TEST_VECTOR.secret, policy },
  { type: "challenge", environmentId, nonce: BRIDGE_PROOF_TEST_VECTOR.nonce },
  { type: "ready", policy },
  { type: "policy", policy: { ...policy, devSites: ["localhost"] } },
  { type: "call", id: "call-1", pageKey: `${environmentId}/${chromeId}`, command: { verb: "click", args: { target: { ref: "e12" } } } },
  { type: "call", id: "call-2", pageKey: "env/session", command: { verb: "navigate", args: { url: "https://www.paypal.com/" } }, allowance: { host: "www.paypal.com" } },
  { type: "ping" },
  { type: "pong" },
  { type: "refused", reason: "This Chrome is no longer paired with this environment." },
];

const reasonOf = (decoded: { readonly ok: boolean; readonly reason?: string }): string | undefined => (decoded.ok ? undefined : decoded.reason);

describe("bridge protocol version 2", () => {
  it("is version 2: version 1's messages with announce, the environment id on hello and challenge, and pair on an unpaired socket", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(2);
    expect(BRIDGE_EXTENSION_MESSAGE_TYPES).toEqual(["announce", "pair", "hello", "proof", "result", "ping", "pong", "refused"]);
    expect(BRIDGE_ENVIRONMENT_MESSAGE_TYPES).toEqual(["announced", "paired", "challenge", "ready", "policy", "call", "ping", "pong", "refused"]);
  });

  it("round-trips every message each side sends through the codec", () => {
    for (const message of fromExtension) expect(decodeFromExtension(encodeBridgeMessage(message)), message.type).toEqual({ ok: true, message });
    for (const message of fromEnvironment) expect(decodeFromEnvironment(encodeBridgeMessage(message)), message.type).toEqual({ ok: true, message });
  });

  it("refuses a malformed message with a reason naming what is wrong", () => {
    expect(reasonOf(decodeFromExtension("{not json"))).toBe("The message is not JSON.");
    expect(reasonOf(decodeFromExtension("[]"))).toBe("The message is not a JSON object with a type.");
    expect(reasonOf(decodeFromExtension(JSON.stringify({ kind: "hello" })))).toBe("The message is not a JSON object with a type.");
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "call" })))).toBe("call is not a message the extension sends.");
    expect(reasonOf(decodeFromEnvironment(JSON.stringify({ type: "hello" })))).toBe("hello is not a message the environment sends.");
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "hello", protocolVersion: 2, extensionVersion: "0.4.2", chromeId, name: "Work" })))).toBe(
      "The hello message is malformed: environmentId: Invalid input: expected string, received undefined",
    );
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "proof", mac: "F11850CE" })))).toMatch(/^The proof message is malformed: mac: /);
    expect(reasonOf(decodeFromEnvironment(JSON.stringify({ type: "call", id: "c", pageKey: "k", command: { verb: "click", args: { target: { ref: "e1", selector: "a" } } } })))).toMatch(
      /^The call message is malformed: command\.args\.target: /,
    );
    expect(reasonOf(decodeFromEnvironment(JSON.stringify({ type: "paired", chromeId, secret: "not-hex", policy })))).toMatch(/^The paired message is malformed: secret: /);
  });

  it("refuses a message longer than the bridge carries", () => {
    const long = encodeBridgeMessage({ type: "refused", reason: "x".repeat(BRIDGE_MESSAGE_MAX_CHARS) });
    expect(reasonOf(decodeFromExtension(long))).toBe(`The message is longer than the bridge's ${BRIDGE_MESSAGE_MAX_CHARS} characters.`);
  });

  it("answers an opening message of a version it does not serve with the Reload sentence, before reading the rest of its shape", () => {
    const reload = "This extension speaks bridge version 1 and this environment speaks 3. Open chrome://extensions and click Reload on the extension.";
    expect(serveBridgeVersion(1, 3)).toBe(reload);
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "announce", protocolVersion: 0 })))).toBe(
      "This extension speaks bridge version 0 and this environment speaks 2. Open chrome://extensions and click Reload on the extension.",
    );
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "hello", protocolVersion: 3, browserId: "old-shape" })))).toBe(
      "This extension speaks bridge version 3 and this environment speaks 2. Open chrome://extensions and click Reload on the extension.",
    );
  });

  it("serves the environment's own bridge version and the one before it", () => {
    expect(serveBridgeVersion(2)).toBe(true);
    expect(serveBridgeVersion(1)).toBe(true);
    expect(serveBridgeVersion(0)).toMatch(/click Reload/);
    expect(serveBridgeVersion(3)).toMatch(/click Reload/);
    expect(serveBridgeVersion(5, 5)).toBe(true);
    expect(serveBridgeVersion(4, 5)).toBe(true);
    expect(serveBridgeVersion(3, 5)).toMatch(/^This extension speaks bridge version 3 and this environment speaks 5\./);
  });

  it("reads a served opening against version 2's shapes, the only ones this package holds", () => {
    expect(decodeFromExtension(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "0.4.1", environmentId, chromeId, name: "Work" })).ok).toBe(true);
    expect(reasonOf(decodeFromExtension(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "0.4.1", browserId: "old-shape", browserName: "Work" })))).toMatch(
      /^The hello message is malformed: environmentId: /,
    );
  });
});

describe("the proof", () => {
  it("is HMAC-SHA256 of the nonce as sent, keyed by the secret's 32 bytes, in lowercase hex: the fixed vector the environment's and the extension's tests share", () => {
    const { secret, nonce, proof } = BRIDGE_PROOF_TEST_VECTOR;
    expect(Buffer.from(secret, "hex")).toHaveLength(32);
    expect(createHmac("sha256", Buffer.from(secret, "hex")).update(nonce, "utf8").digest("hex")).toBe(proof);
    expect(proof).toBe("f11850ce2b92900b74888d4b8512576ee53d386643a045a8a46d9e0a3e760bfd");
  });

  it("is not the HMAC keyed by the secret's characters, the reading the definition rules out", () => {
    const { secret, nonce, proof } = BRIDGE_PROOF_TEST_VECTOR;
    expect(createHmac("sha256", Buffer.from(secret, "utf8")).update(nonce).digest("hex")).not.toBe(proof);
  });

  it("is carried by messages that take the vector's secret, nonce and proof", () => {
    const { secret, nonce, proof } = BRIDGE_PROOF_TEST_VECTOR;
    expect(decodeFromEnvironment(encodeBridgeMessage({ type: "paired", chromeId, secret, policy })).ok).toBe(true);
    expect(decodeFromEnvironment(encodeBridgeMessage({ type: "challenge", environmentId, nonce })).ok).toBe(true);
    expect(decodeFromExtension(encodeBridgeMessage({ type: "proof", mac: proof })).ok).toBe(true);
  });
});

describe("the port file", () => {
  it("is port.json in the extension's folder: the listener's port, the environment's id and name, and the harness version", () => {
    expect(PORT_FILE_NAME).toBe("port.json");
    const file = { port: 47615, environmentId, environmentName: "SYSTEM-SERVER", harnessVersion: "0.4.2" };
    expect(PortFile.parse(file)).toEqual(file);
    for (const broken of [{ ...file, port: 0 }, { ...file, port: 65536 }, { ...file, environmentId: "server" }, { ...file, environmentName: "" }, { port: 47615 }]) {
      expect(PortFile.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
    }
  });
});

describe("the extension's fixed id", () => {
  it("is what Chrome derives from the manifest key: the first 16 bytes of its DER's SHA-256, each nibble written a to p", () => {
    const digest = createHash("sha256").update(Buffer.from(EXTENSION_MANIFEST_KEY, "base64")).digest("hex").slice(0, 32);
    expect(EXTENSION_ID).toBe([...digest].map((nibble) => String.fromCharCode(0x61 + Number.parseInt(nibble, 16))).join(""));
    expect(EXTENSION_ID).toBe("fnmgmfbcdmlefliicojlcpehmcieoajl");
  });

  it("is the key's public half alone, an RSA public key, and the origin the listener admits", () => {
    const key = createPublicKey({ key: Buffer.from(EXTENSION_MANIFEST_KEY, "base64"), format: "der", type: "spki" });
    expect(key.type).toBe("public");
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(EXTENSION_ORIGIN).toBe("chrome-extension://fnmgmfbcdmlefliicojlcpehmcieoajl");
  });
});
