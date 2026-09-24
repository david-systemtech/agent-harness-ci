import {
  ClientSessionCredential,
  PAIR_PATH,
  normalisePairingCode,
  parsePairingLink,
  type ClientSessionCredential as Credential,
} from "@agent-harness/contracts";
import { parseAddress } from "./connections/address.js";
import type { ClientIdentity, HttpFetch } from "./platform.js";

export { DEFAULT_ENVIRONMENT_PORT } from "./connections/address.js";

/**
 * Pairing, client side (docs/specs/client-runtime.md, "Pairing and the
 * bootstrap grant"): a link (`http://<address>/pair#<code>`, the code in the
 * fragment so it never reaches a log), the text of its QR, or an address and
 * the short code, exchanged at `POST /api/pair` for a client session.
 */

/** What David pastes, scans or types. */
export type PairingInput = { readonly link: string } | { readonly address: string; readonly code: string };

/** Pair again in place: exchange the code for the saved connection to this environment, which must be the one that answers. */
export interface PairingOptions {
  readonly rePair?: string;
}

/**
 * Why a pairing failed. The six the specification names, and four more a
 * person can cause: a link or address that is not one, a code the
 * environment never issued, too many tries.
 */
export type PairingFailureReason =
  | "expired-code"
  | "used-code"
  | "unreachable"
  | "protocol-mismatch"
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
  /** The token is kept, the record written and a connection attempted. */
  | { readonly status: "paired"; readonly environmentId: string }
  /** The environment is saved already: nothing was exchanged; ask again with `rePair` to pair it again in place. */
  | { readonly status: "re-pair-offered"; readonly environmentId: string; readonly name: string }
  | { readonly status: "failed"; readonly failure: PairingFailure };

export const failed = (reason: PairingFailureReason, message: string): PairingOutcome => ({ status: "failed", failure: { reason, message } });

/** The origin and canonical code in what was pasted or typed, or why there are none. */
export const parsePairingInput = (
  input: PairingInput,
): { readonly ok: true; readonly origin: string; readonly code: string } | { readonly ok: false; readonly failure: PairingFailure } => {
  const refuse = (reason: PairingFailureReason, message: string) => ({ ok: false as const, failure: { reason, message } });
  if ("link" in input) {
    const link = parsePairingLink(input.link);
    const origin = link && parseAddress(link.origin);
    if (!link || !origin) return refuse("invalid-link", "That is not a pairing link: it looks like http://<address>/pair#<code>.");
    return { ok: true, origin, code: link.code };
  }
  const origin = parseAddress(input.address);
  if (!origin) return refuse("invalid-address", `"${input.address}" is not an address: give a host name or IP address and, if not 7433, its port.`);
  const code = normalisePairingCode(input.code);
  if (!code) return refuse("invalid-code", "That is not a pairing code: it is ten letters and digits, like K7Q2M-XH4RT.");
  return { ok: true, origin, code };
};

const EXCHANGE_FAILURES: Record<string, PairingFailure> = {
  pairing_expired: { reason: "expired-code", message: "The pairing code has expired; ask the environment for a new one." },
  pairing_used: { reason: "used-code", message: "The pairing code has been used already; each code pairs one client." },
  pairing_invalid: { reason: "invalid-code", message: "The environment issued no such pairing code; check it and try again." },
  protocol_mismatch: { reason: "protocol-mismatch", message: "The environment speaks another protocol version than this client." },
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
): Promise<{ readonly ok: true; readonly credential: Credential } | { readonly ok: false; readonly failure: PairingFailure }> => {
  let status: number;
  let body: unknown;
  try {
    const response = await fetch(`${origin}${PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, kind: client.kind, label: client.label, protocolVersion }),
    });
    status = response.status;
    body = await response.json();
  } catch (error) {
    return { ok: false, failure: { reason: "unreachable", message: `Nothing answered at ${origin}: ${error instanceof Error ? error.message : String(error)}.` } };
  }
  if (status === 200) {
    const credential = ClientSessionCredential.safeParse(body);
    if (credential.success) return { ok: true, credential: credential.data };
  }
  const errorCode = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["code"] : undefined;
  const known = typeof errorCode === "string" ? EXCHANGE_FAILURES[errorCode] : undefined;
  const message = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["message"] : undefined;
  return {
    ok: false,
    failure: known ?? { reason: "refused", message: `The environment refused the pairing (HTTP ${status})${typeof message === "string" ? `: ${message}` : "."}` },
  };
};
