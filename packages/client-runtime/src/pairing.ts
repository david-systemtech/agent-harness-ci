import {
  DEFAULT_ENVIRONMENT_PORT,
  PAIR_PATH,
  PRODUCT_NAME,
  normalisePairingCode,
  parsePairingLink,
  type ClientSessionCredential,
} from "@agent-harness/contracts";
import { parseAddress } from "./connections/address.js";
import type { RemoveResult } from "./connections/records.js";
import { compareProtocol, type DiscoveryRefusal } from "./discovery.js";
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
  /** One line for people, the same in every renderer. */
  readonly message: string;
}

export type PairingOutcome =
  /**
   * The token is kept, the record written and the connection made or
   * attempted. On a re-pair in place, `replaced` says whether the client
   * session it gave up was revoked.
   */
  | { readonly status: "paired"; readonly environmentId: string; readonly replaced?: RemoveResult }
  /** The environment is saved already: nothing was exchanged; ask again with `rePair` to pair it again in place. */
  | { readonly status: "re-pair-offered"; readonly environmentId: string; readonly name: string }
  | { readonly status: "failed"; readonly failure: PairingFailure };

export const pairingFailed = (reason: PairingFailureReason, message: string): PairingOutcome => ({
  status: "failed",
  failure: { reason, message },
});

/** A discovery refusal as a pairing failure: starting or draining is `not-ready`. */
export const discoveryFailure = (reason: DiscoveryRefusal): PairingFailureReason =>
  reason === "starting" || reason === "draining" ? "not-ready" : reason;

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

/** The origin and canonical code in what was pasted or typed, or why there are none. */
export const parsePairingInput = (
  input: PairingInput,
): { readonly ok: true; readonly origin: string; readonly code: string } | { readonly ok: false; readonly failure: PairingFailure } => {
  const refuse = (reason: PairingFailureReason, message: string) => ({ ok: false as const, failure: { reason, message } });
  if ("link" in input) {
    const link = parsePairingLink(unwrapped(input.link));
    const origin = link && parseAddress(link.origin);
    if (!link || !origin) return refuse("invalid-link", "That is not a pairing link: it looks like http://<address>/pair#<code>.");
    return { ok: true, origin, code: link.code };
  }
  const origin = parseAddress(input.address);
  if (!origin) {
    return refuse(
      "invalid-address",
      `"${input.address}" is not an address: give a host name or IP address and, if not ${DEFAULT_ENVIRONMENT_PORT}, its port.`,
    );
  }
  const code = normalisePairingCode(input.code);
  if (!code) return refuse("invalid-code", "That is not a pairing code: it is ten letters and digits, like K7Q2M-XH4RT.");
  return { ok: true, origin, code };
};

const REFUSALS: Readonly<Record<string, PairingFailure>> = {
  pairing_expired: { reason: "expired-code", message: "The pairing code has expired; ask the environment for a new one." },
  pairing_used: { reason: "used-code", message: "The pairing code has been used already; each code pairs one client." },
  pairing_invalid: { reason: "invalid-code", message: "The environment issued no such pairing code; check it and try again." },
  rate_limited: { reason: "rate-limited", message: "Too many pairing attempts from this address; wait a minute and try again." },
  unavailable: { reason: "not-ready", message: "The environment is not ready yet; try again in a moment." },
};

/** `POST /api/pair` with the code, the client's kind and label and its protocol version: a client session, or why not. */
export const exchangeCode = async (
  fetch: HttpFetch,
  origin: string,
  code: string,
  client: ClientIdentity,
  protocolVersion: number,
): Promise<{ readonly ok: true; readonly credential: ClientSessionCredential } | { readonly ok: false; readonly failure: PairingFailure }> => {
  const answer = await postExchange(fetch, `${origin}${PAIR_PATH}`, { code, kind: client.kind, label: client.label, protocolVersion });
  if (answer.ok) return answer;
  if (answer.kind === "unreachable") return { ok: false, failure: { reason: "unreachable", message: answer.message } };
  if (answer.code === "protocol_mismatch") {
    const theirs = answer.data["protocolVersion"];
    const mismatch = typeof theirs === "number" ? compareProtocol(theirs, protocolVersion) : undefined;
    return { ok: false, failure: mismatch ?? { reason: "protocol-mismatch", message: answer.message ?? "The protocol versions differ." } };
  }
  // Own keys only: a code such as `constructor` names nothing here and is `refused`.
  const known = answer.code !== undefined && Object.hasOwn(REFUSALS, answer.code) ? REFUSALS[answer.code] : undefined;
  return {
    ok: false,
    failure: known ?? {
      reason: "refused",
      message: `The environment refused the pairing (HTTP ${answer.status})${answer.message === undefined ? "." : `: ${answer.message}`}`,
    },
  };
};
