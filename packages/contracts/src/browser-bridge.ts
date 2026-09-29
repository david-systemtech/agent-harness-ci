import { z } from "zod";
import { PageCall, PageOutcome, type PageCommand } from "./browser-driver.js";
import { PagePolicy } from "./browser-policy.js";
import { EnvironmentId } from "./primitives.js";

/**
 * Bridge protocol version 2: an environment and the extension in a Chrome on
 * its machine, over a WebSocket the extension dials to the environment's
 * listener on loopback (browser spec, "The extension, its folder and its
 * listener"; ADR 0014, ADR 0024). Version 1's messages with three changes:
 *
 * - an extension that holds no credential dials anyway and opens with
 *   `announce` (its protocol and extension versions and the name it would
 *   pair as); the environment answers `announced` with its id and name and
 *   keeps the socket, which is the unpaired signal, and `pair` (the code the
 *   person typed, the name) comes on that socket;
 * - `hello` and `challenge` carry the environment id, so an extension that
 *   finds another environment on its port says so instead of proving to it;
 * - an environment serves its bridge version and the one before, and
 *   answers any other with the Reload sentence.
 *
 * Pairing answers `paired` with the Chrome's id, a 32-byte secret and the
 * page policy. Every later connection proves the secret without sending it:
 * `hello`, the environment's `challenge` with a nonce, and the extension's
 * `proof`, then `ready` with the policy, `policy` again on every change, and
 * `call` and `result`, one verb each, matched by id. Either side may send
 * `ping`, `pong` and `refused`.
 */

/** The bridge protocol these messages are. */
export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Whether an environment speaking `ours` serves an extension speaking
 * `theirs`: its own version and the one before, so an update that raises the
 * version leaves a Chrome working until it is reloaded. Anything else is
 * answered with the Reload sentence: the environment's folder holds the
 * extension it ships, which Reload loads.
 */
export const serveBridgeVersion = (theirs: number, ours: number = BRIDGE_PROTOCOL_VERSION): true | string =>
  theirs === ours || theirs === ours - 1
    ? true
    : `This extension speaks bridge version ${theirs} and this environment speaks ${ours}. Open chrome://extensions and click Reload on the extension.`;

// The parts -------------------------------------------------------------------

/** A paired Chrome's id: minted by the environment when the Chrome pairs. */
export const ChromeId = z.uuid().meta({ description: "A paired Chrome's id: a UUID its environment mints when it pairs." });
export type ChromeId = z.infer<typeof ChromeId>;

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/** A secret, a nonce or a proof: 32 bytes as 64 lowercase hex characters. */
const hex32 = (description: string) => z.string().regex(HEX_32_BYTES).meta({ description });

/** A verb call's id, chosen by the environment and echoed by the result. */
const CallId = z.string().min(1).max(256).meta({ description: "The call's id, chosen by the environment and echoed by its result." });

/** The name a Chrome pairs as, as the extension sends it: the environment trims and cleans it. */
const ChromeName = z.string().max(1_000).meta({ description: "The name the Chrome pairs as (Work, Personal), as the person typed it; the environment trims and cleans it." });

const ExtensionVersion = z.string().min(1).max(64).meta({ description: "The extension's version: the harness version it was built with." });

const OpeningVersion = z.int().min(1).meta({ description: "The bridge protocol version the extension speaks: served when it is the environment's or the one before." });

const Reason = z.string().min(1).max(4_096).meta({ description: "Why, as a sentence for a person." });

// From the extension -----------------------------------------------------------

export const BridgeAnnounce = z
  .object({ type: z.literal("announce"), protocolVersion: OpeningVersion, extensionVersion: ExtensionVersion, name: ChromeName })
  .meta({ description: "announce: an extension that holds no credential opens its socket with its versions and the name it would pair as." });

export const BridgePair = z
  .object({
    type: z.literal("pair"),
    code: z.string().min(1).max(64).meta({ description: "The pairing code as the person typed it; the environment reads it in its canonical form." }),
    name: ChromeName,
  })
  .meta({ description: "pair: the code the person typed, and the name, on the announced socket." });

export const BridgeHello = z
  .object({
    type: z.literal("hello"),
    protocolVersion: OpeningVersion,
    extensionVersion: ExtensionVersion,
    environmentId: EnvironmentId.meta({ description: "The environment the extension paired with." }),
    chromeId: ChromeId,
    name: ChromeName.meta({ description: "The name the Chrome paired as; a later hello never renames it." }),
  })
  .meta({ description: "hello: a paired extension opens its socket with its versions, the environment it paired with and its Chrome's id." });

export const BridgeProof = z
  .object({
    type: z.literal("proof"),
    mac: hex32("HMAC-SHA256 of the challenge's nonce as sent (its UTF-8 bytes), keyed by the secret's 32 bytes, in lowercase hex."),
  })
  .meta({ description: "proof: the answer to a challenge, which proves the secret without sending it." });

export const BridgeResult = z
  .object({ type: z.literal("result"), id: CallId, result: PageOutcome })
  .meta({ description: "result: a verb's answer, its value or a refusal, for the call with this id." });

export const BridgePing = z.object({ type: z.literal("ping") }).meta({ description: "ping: either side, to keep the socket and the extension's worker alive." });
export const BridgePong = z.object({ type: z.literal("pong") }).meta({ description: "pong: the answer to a ping." });
export const BridgeRefused = z
  .object({ type: z.literal("refused"), reason: Reason })
  .meta({ description: "refused: either side, the socket is refused or ending, and why." });

// From the environment ---------------------------------------------------------

export const BridgeAnnounced = z
  .object({ type: z.literal("announced"), environmentId: EnvironmentId, environmentName: z.string().min(1) })
  .meta({ description: "announced: the environment's answer to announce, its id and name; the socket is kept for pair." });

export const BridgePaired = z
  .object({
    type: z.literal("paired"),
    chromeId: ChromeId,
    secret: hex32("The Chrome's secret: 32 random bytes as 64 lowercase hex characters, kept by the extension and never sent again."),
    policy: PagePolicy,
  })
  .meta({ description: "paired: the code was good; the Chrome's id, its secret and the page policy." });

export const BridgeChallenge = z
  .object({
    type: z.literal("challenge"),
    environmentId: EnvironmentId.meta({ description: "The environment on this port: an extension paired with another does not prove to it." }),
    nonce: hex32("A nonce good for one proof: 32 random bytes as 64 lowercase hex characters."),
  })
  .meta({ description: "challenge: the environment's answer to hello, a nonce to prove the secret on." });

export const BridgeReady = z.object({ type: z.literal("ready"), policy: PagePolicy }).meta({ description: "ready: the proof was good; the socket is live, under this page policy." });

export const BridgePolicy = z.object({ type: z.literal("policy"), policy: PagePolicy }).meta({ description: "policy: the page policy changed." });

export const BridgeCall = PageCall.extend({ type: z.literal("call"), id: CallId }).meta({
  description: "call: one verb for one session's page, with a one-time allowance when a person allowed a denylisted address.",
});
export type BridgeCall = Omit<z.infer<typeof BridgeCall>, "command"> & { readonly command: PageCommand };

// The two directions -----------------------------------------------------------

/** What the extension sends, by type. */
const EXTENSION_MESSAGES = {
  announce: BridgeAnnounce,
  pair: BridgePair,
  hello: BridgeHello,
  proof: BridgeProof,
  result: BridgeResult,
  ping: BridgePing,
  pong: BridgePong,
  refused: BridgeRefused,
} as const;

/** What the environment sends, by type. */
const ENVIRONMENT_MESSAGES = {
  announced: BridgeAnnounced,
  paired: BridgePaired,
  challenge: BridgeChallenge,
  ready: BridgeReady,
  policy: BridgePolicy,
  call: BridgeCall,
  ping: BridgePing,
  pong: BridgePong,
  refused: BridgeRefused,
} as const;

export const BRIDGE_EXTENSION_MESSAGE_TYPES = Object.keys(EXTENSION_MESSAGES) as (keyof typeof EXTENSION_MESSAGES)[];
export const BRIDGE_ENVIRONMENT_MESSAGE_TYPES = Object.keys(ENVIRONMENT_MESSAGES) as (keyof typeof ENVIRONMENT_MESSAGES)[];

export const BridgeFromExtension = z
  .discriminatedUnion("type", [BridgeAnnounce, BridgePair, BridgeHello, BridgeProof, BridgeResult, BridgePing, BridgePong, BridgeRefused])
  .meta({ description: "A message the extension sends, told apart by its type." });
export type BridgeFromExtension = z.infer<typeof BridgeFromExtension>;

export const BridgeFromEnvironment = z
  .discriminatedUnion("type", [BridgeAnnounced, BridgePaired, BridgeChallenge, BridgeReady, BridgePolicy, BridgeCall, BridgePing, BridgePong, BridgeRefused])
  .meta({ description: "A message the environment sends, told apart by its type." });
export type BridgeFromEnvironment = Exclude<z.infer<typeof BridgeFromEnvironment>, { readonly type: "call" }> | BridgeCall;

// The codec ------------------------------------------------------------------

/** The longest message the bridge carries, in characters. */
export const BRIDGE_MESSAGE_MAX_CHARS = 8 * 1024 * 1024;

/** A message read off the socket, or the reason it was refused: a sentence to send back in `refused`. */
export type BridgeDecoding<M> = { readonly ok: true; readonly message: M } | { readonly ok: false; readonly reason: string };

/** The messages that open a socket, whose protocol version is read before the rest of their shape. */
const OPENING_TYPES: ReadonlySet<string> = new Set(["announce", "hello"]);

const refuse = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });

const decode = (text: string, messages: Readonly<Record<string, z.ZodType>>, sender: string): BridgeDecoding<unknown> => {
  if (text.length > BRIDGE_MESSAGE_MAX_CHARS) return refuse(`The message is longer than the bridge's ${BRIDGE_MESSAGE_MAX_CHARS} characters.`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse("The message is not JSON.");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || typeof (json as { type?: unknown }).type !== "string") {
    return refuse("The message is not a JSON object with a type.");
  }
  const { type, protocolVersion } = json as { readonly type: string; readonly protocolVersion?: unknown };
  const schema = Object.hasOwn(messages, type) ? messages[type] : undefined;
  if (schema === undefined) return refuse(`${type.slice(0, 64)} is not a message the ${sender} sends.`);
  // Another version may shape the rest of its opening differently, and must still be told to reload.
  if (OPENING_TYPES.has(type) && typeof protocolVersion === "number" && Number.isInteger(protocolVersion)) {
    const served = serveBridgeVersion(protocolVersion);
    if (served !== true) return refuse(served);
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const [issue] = parsed.error.issues;
  const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return refuse(`The ${type} message is malformed: ${where}${issue?.message ?? "it does not match its schema."}`);
};

/** A message the extension sent, read by the environment: an opening of a version it does not serve is refused with the Reload sentence. */
export const decodeFromExtension = (text: string): BridgeDecoding<BridgeFromExtension> =>
  decode(text, EXTENSION_MESSAGES, "extension") as BridgeDecoding<BridgeFromExtension>;

/** A message the environment sent, read by the extension. */
export const decodeFromEnvironment = (text: string): BridgeDecoding<BridgeFromEnvironment> =>
  decode(text, ENVIRONMENT_MESSAGES, "environment") as BridgeDecoding<BridgeFromEnvironment>;

/** A message as JSON text, one message per WebSocket frame. */
export const encodeBridgeMessage = (message: BridgeFromExtension | BridgeFromEnvironment): string => JSON.stringify(message);

// The proof ------------------------------------------------------------------

/**
 * A fixed case of the proof, which the environment's tests and the
 * extension's both run their implementation against: the secret is the
 * bytes 0x00 to 0x1f and the nonce the bytes 0x20 to 0x3f, each written as
 * the wire writes it; the proof is HMAC-SHA256 of the nonce's 64 characters
 * as UTF-8, keyed by the secret's 32 bytes (not its characters), in lowercase
 * hex. In Node that is `createHmac("sha256", Buffer.from(secret, "hex")).update(nonce).digest("hex")`.
 */
export const BRIDGE_PROOF_TEST_VECTOR = {
  secret: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  nonce: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  proof: "f11850ce2b92900b74888d4b8512576ee53d386643a045a8a46d9e0a3e760bfd",
} as const;

// The port file ----------------------------------------------------------------

/** The file the environment writes into the extension's folder once its listener is bound, which the extension reads at each connection attempt. */
export const PORT_FILE_NAME = "port.json";

/** The port file: where the extension finds its environment. */
export const PortFile = z
  .object({
    port: z.int().min(1).max(65_535).meta({ description: "The port the environment's listener is bound to on loopback." }),
    environmentId: EnvironmentId,
    environmentName: z.string().min(1).meta({ description: "The environment's name, for the extension's options page." }),
    harnessVersion: z.string().min(1).meta({ description: "The harness version the environment runs, which the folder's extension was built with." }),
  })
  .meta({ description: "The port file in the extension's folder: the listener's port, the environment's id and name, and the harness version." });
export type PortFile = z.infer<typeof PortFile>;

// The extension's id -------------------------------------------------------------

/**
 * The manifest's `key`: the public half of an RSA key pair, base64 DER, from
 * which Chrome derives the extension's id, so the id is the same on every
 * machine that loads the folder. Only the public half exists: the private
 * half was never kept, nothing signs a package, and a Web Store listing
 * would come with a key of the Store's.
 */
export const EXTENSION_MANIFEST_KEY = [
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAquAkqOafHe6fazQnVbHdOGhspxpz",
  "WNqGk3NNouAsJRYXr88uV1M6aPy/TZRR5HewELAeR7i8+pc/MLVafVZDbLMTd3UCqAUDjT3o",
  "FaqwzsSdxm7APcIVehRIxsspZrgs2/Dx+hM9+9b6+uQ0VyGUXR6PnrPrPO6XXdRca8CV8HQK",
  "4bAizGPe3QKzKMtKj3g3E/xCjqvSlswz+Osw4/7UJupHUx7A6Bw2+KxRG12Y73ZHMsLle8iE",
  "xZYaVqRlIk32Txhd15KpizVe+eFDNW5fYgzz4JoHpfpwLOqbbnaFwYv4yuPf1uWwkrhXM0Hw",
  "b6G3WtGJjbHtiKA8QNTSXo3HBQIDAQAB",
].join("");

/** The extension's fixed id: the first 16 bytes of the manifest key's SHA-256, each nibble written `a` to `p`, as Chrome derives it. */
export const EXTENSION_ID = "fnmgmfbcdmlefliicojlcpehmcieoajl";

/** The Origin the extension's socket carries, which the listener admits and no web page can set. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
