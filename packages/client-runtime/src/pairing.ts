import type { SecretStorage } from "./platform.js";
import {
  PAIR_PATH,
  PRODUCT_NAME,
  normalisePairingCode,
  parsePairingLink,
  type ClientSessionCredential,
} from "@agent-harness/contracts";
import { parseAddress } from "./connections/address.js";
import type { RemoveResult } from "./connections/records.js";
import { compareProtocol, type DiscoveryRead, type DiscoveryRefusal, type ProtocolRefusal } from "./discovery.js";
import { postExchange } from "./exchange.js";
import type { ClientIdentity, HttpFetch } from "./platform.js";

/**
 * Pairing, client side (docs/specs/client-runtime.md, "Pairing and the
 * bootstrap grant"): a link (`http://<address>/pair#<code>`, the code in the
 * fragment so it never reaches a log), the text of its QR, or an address and
 * the short code, exchanged at `POST /api/pair` for a client session.
 */

/** What David pastes, scans or types, or a pairing deep link the desktop was opened with (`pairingDeepLink`). */
export type PairingInput = { readonly link: string } | { readonly address: string; readonly code: string };

/** Pair again in place: exchange the code for the saved connection to this environment, which must be the one that answers. */
export interface PairingOptions {
  readonly rePair?: string;
  /** Accept only a verified grant with every scope and the highest run ceiling, before replacing a saved pairing. */
  readonly fullAccess?: boolean;
}

/**
 * Why a pairing failed: the six the specification names, `unsupported-client`
 * beside `protocol-mismatch` to say which side is behind, and five more a
 * person can cause.
 */
export type PairingFailureReason =
  | "expired-code"
  | "used-code"
  | "unreachable"
  | "protocol-mismatch"
  | "unsupported-client"
  | "not-ready"
  | "different-environment"
  | "invalid-link"
  | "invalid-address"
  | "invalid-code"
  | "rate-limited"
  | "refused";

export interface PairingFailure {
  readonly reason: PairingFailureReason;
  /** One line for people, the same in every renderer, in setup-copy.md §4.2's words. */
  readonly message: string;
  /** The raw failure behind the line, one line each, for Details (setup-copy.md §1 rule 7); absent where the line says it all. */
  readonly details?: readonly string[];
}

export type PairingOutcome =
  /**
   * The token is kept, the record written and the connection made or
   * attempted. On a re-pair in place, `replaced` says whether the client
   * session it gave up was revoked. `credentialStorage`, when the store reports
   * it, says whether the token uses a fresh or successfully read OS item.
   */
  | { readonly status: "paired"; readonly environmentId: string; readonly replaced?: RemoveResult; readonly credentialStorage?: SecretStorage }
  /** The environment is saved already: nothing was exchanged; ask again with `rePair` to pair it again in place. */
  | { readonly status: "re-pair-offered"; readonly environmentId: string; readonly name: string }
  | { readonly status: "failed"; readonly failure: PairingFailure };

export const pairingFailed = (reason: PairingFailureReason, message: string, details?: readonly string[]): PairingOutcome => ({
  status: "failed",
  failure: { reason, message, ...(details !== undefined && { details }) },
});

/** The host and port of `origin` (an origin `parseAddress` made), as a person reads an address. */
const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, "");

/** Nothing answered at `origin`: what to check, and what the platform said (`fetch failed`) in Details. */
export const unreachableFailure = (origin: string, raw: string): PairingFailure => ({
  reason: "unreachable",
  message: `Nothing answered at ${hostOf(origin)}. Check that the other computer is on and that both are connected to Tailscale.`,
  details: [raw],
});

/** The two sides' protocols differ: which side to update, by name. */
export const protocolFailure = (reason: ProtocolRefusal, name: string, raw: string): PairingFailure => ({
  reason,
  message: `This app and ${name} run versions that cannot talk. Update ${reason === "unsupported-client" ? "this app" : name}, then pair again.`,
  details: [raw],
});

const NOT_READY = "The other computer is still starting. Try again in a moment.";

/** What reading discovery at `origin` came to, when it did not come to a document. */
export const discoveryReadFailure = (origin: string, read: Extract<DiscoveryRead, { ok: false }>): PairingFailure =>
  read.kind === "unreachable" ? unreachableFailure(origin, read.message) : { reason: "refused", message: `${hostOf(origin)} is not running agent-harness.`, details: [read.message] };

/** A discovery refusal as a pairing failure: starting or draining is `not-ready`; a protocol gap names the side to update. */
export const discoveryFailure = (reason: DiscoveryRefusal, name: string, raw: string): PairingFailure => {
  switch (reason) {
    case "starting":
    case "draining":
      return { reason: "not-ready", message: NOT_READY, details: [raw] };
    case "unsupported-client":
    case "protocol-mismatch":
      return protocolFailure(reason, name, raw);
    case "different-environment":
      return { reason, message: "That address reaches a different computer than the one that made the code. Make a new code and try again.", details: [raw] };
  }
};

/**
 * A pairing link as the desktop app is handed it by the OS, from a page or
 * another app: `agent-harness://pair?link=<the pairing link, percent-encoded>`
 * (a chosen default). `connections.add` takes it as it takes the link.
 */
export const pairingDeepLink = (link: string): string => `${PRODUCT_NAME}://pair?link=${encodeURIComponent(link)}`;

const DEEP_LINK = new RegExp(`^${PRODUCT_NAME}://pair/?\\?link=([^&#\\s]+)$`, "i");

/** The pairing link a pairing deep link carries; anything else as it is. */
const unwrapped = (text: string): string => {
  const match = DEEP_LINK.exec(text.trim());
  if (!match) return text;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return text;
  }
};

/**
 * Whether a pairing link reaches only the computer that made it: its address
 * is loopback (127.0.0.0/8, localhost, ::1), as an environment bound to
 * loopback alone hands out, which no other device can use (#1847).
 */
export const pairingLinkIsLocal = (link: string): boolean => {
  const host = parsePairingLink(link)?.origin.replace(/^[a-z]+:\/\//i, "").replace(/:\d+$/, "").toLowerCase();
  return host !== undefined && (/^127(\.\d{1,3}){3}$/.test(host) || host === "localhost" || host === "[::1]");
};

/** The origin and canonical code in what was pasted or typed, or why there are none. */
export const parsePairingInput = (
  input: PairingInput,
): { readonly ok: true; readonly origin: string; readonly code: string } | { readonly ok: false; readonly failure: PairingFailure } => {
  const refuse = (reason: PairingFailureReason, message: string) => ({ ok: false as const, failure: { reason, message } });
  if ("link" in input) {
    const link = parsePairingLink(unwrapped(input.link));
    const origin = link && parseAddress(link.origin);
    if (!link || !origin) return refuse("invalid-link", "That is not a pairing link. A pairing link ends with /pair# and a code.");
    return { ok: true, origin, code: link.code };
  }
  const origin = parseAddress(input.address);
  if (!origin) return refuse("invalid-address", "Enter the other computer's address, like my-server or 192.168.1.20.");
  const code = normalisePairingCode(input.code);
  if (!code) return refuse("invalid-code", "A pairing code has 10 letters and numbers, like K7Q2M-XH4RT.");
  return { ok: true, origin, code };
};

/** The exchange's refusals by error code, in setup-copy.md §4.2's words. */
const REFUSALS: Readonly<Record<string, Omit<PairingFailure, "details">>> = {
  pairing_expired: { reason: "expired-code", message: "This code has run out. Make a new code on the other computer." },
  pairing_used: { reason: "used-code", message: "This code was already used. Make a new code on the other computer." },
  pairing_invalid: { reason: "invalid-code", message: "The other computer does not know this code. Check it, or make a new one." },
  rate_limited: { reason: "rate-limited", message: "Too many tries. Wait one minute, then try again." },
  unavailable: { reason: "not-ready", message: NOT_READY },
};

/**
 * `POST /api/pair` with the code, the client's kind and label and its
 * protocol version: a client session, or why not, the environment that made
 * the code named `name` in the line (its host until discovery said).
 */
export const exchangeCode = async (
  fetch: HttpFetch,
  origin: string,
  code: string,
  client: ClientIdentity,
  protocolVersion: number,
  name: string = hostOf(origin),
): Promise<{ readonly ok: true; readonly credential: ClientSessionCredential } | { readonly ok: false; readonly failure: PairingFailure }> => {
  const answer = await postExchange(fetch, `${origin}${PAIR_PATH}`, { code, kind: client.kind, label: client.label, protocolVersion });
  if (answer.ok) return answer;
  if (answer.kind === "unreachable") return { ok: false, failure: unreachableFailure(origin, answer.message) };
  const raw = `${answer.code ?? "no error code"} (HTTP ${answer.status})${answer.message === undefined ? "" : `: ${answer.message}`}`;
  if (answer.code === "protocol_mismatch") {
    const theirs = answer.data["protocolVersion"];
    const mismatch = typeof theirs === "number" ? compareProtocol(theirs, protocolVersion) : undefined;
    return { ok: false, failure: protocolFailure(mismatch?.reason ?? "protocol-mismatch", name, raw) };
  }
  // Own keys only: a code such as `constructor` names nothing here and is `refused`.
  const known = answer.code !== undefined && Object.hasOwn(REFUSALS, answer.code) ? REFUSALS[answer.code] : undefined;
  return { ok: false, failure: { ...(known ?? { reason: "refused", message: `${hostOf(origin)} did not accept the pairing. Make a new code and try again.` }), details: [raw] } };
};
