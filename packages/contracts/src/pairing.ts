import { z } from "zod";
import {
  InternalError,
  InvalidParamsError,
  RateLimitedError,
  UnavailableError,
  errorSchema,
} from "./errors.js";
import { ProtocolVersion } from "./flags.js";
import { ClientKind } from "./primitives.js";

/**
 * Pairing: how a client on another machine, or any client that cannot read
 * the bootstrap grant, gets a client session. An admin mints a one-time code
 * (`access.pairings.create`, or `pair` on the CLI) valid for ten minutes; the
 * client exchanges it once at `PAIR_PATH` for a client session with the
 * scopes and ceiling chosen when the code was made.
 */

/** Where a client exchanges a pairing code: `POST`, from any bound address. */
export const PAIR_PATH = "/api/pair";

/** The path of a pairing link: `http://<address>/pair#<code>`, the code in the fragment so it never reaches a log. */
export const PAIR_LINK_PATH = "/pair";

/** How long a pairing code is valid: ten minutes (env spec, "Pairing"). */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * The characters a pairing code is made of: digits and capital letters
 * without 0, 1, I, L, O and U, which are misread for one another or spell
 * words. A chosen default.
 */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** How many characters a pairing code has: ten, about 49 bits. A chosen default. */
export const PAIRING_CODE_LENGTH = 10;

const CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/**
 * A pairing code as typed, in its one canonical form: upper-cased, with the
 * spaces and hyphens people type between groups removed. Undefined when what
 * is left is not a code.
 */
export const normalisePairingCode = (typed: string): string | undefined => {
  const code = typed.replace(/[\s-]/g, "").toUpperCase();
  return CODE.test(code) ? code : undefined;
};

/** A canonical code in two groups of five, for people to read and type: `K7Q2M-XH4RT`. */
export const formatPairingCode = (code: string): string =>
  code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;

/** The pairing link for `code` on the environment at `origin` (`http://host:port`). */
export const pairingLink = (origin: string, code: string): string => `${origin}${PAIR_LINK_PATH}#${code}`;

/** `scheme://host[:port]/pair#code`, read without `URL`, which the contracts' plain ES library does not declare. */
const PAIRING_LINK = /^(https?):\/\/([^/?#\s]+)\/pair#([^#\s]+)$/i;

/**
 * The environment's origin and the code a pairing link carries; undefined
 * for anything that is not one. The exchange is at `PAIR_PATH` on that origin.
 */
export const parsePairingLink = (link: string): { readonly origin: string; readonly code: string } | undefined => {
  const match = PAIRING_LINK.exec(link.trim());
  if (!match) return undefined;
  const [, scheme, host, fragment] = match as unknown as [string, string, string, string];
  let typed: string;
  try {
    typed = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  const code = normalisePairingCode(typed);
  return code === undefined ? undefined : { origin: `${scheme.toLowerCase()}://${host.toLowerCase()}`, code };
};

/** The body of `POST /api/pair`. */
export const PairRequest = z
  .object({
    code: z.string().min(1).max(64).meta({
      description: "The pairing code, as typed or as the link's fragment carries it; case, spaces and hyphens are ignored.",
    }),
    kind: ClientKind,
    label: z.string().min(1).max(200).meta({ description: "A name for the client session, for people." }),
    protocolVersion: ProtocolVersion,
  })
  .meta({ description: "A client's exchange of a pairing code for a client session." });
export type PairRequest = z.infer<typeof PairRequest>;

/** The code is not one this environment issued. */
export const PairingInvalidError = errorSchema("pairing_invalid", z.object({})).meta({
  description: "The pairing code is not one this environment issued.",
});
/** The code was issued, and its ten minutes are over. */
export const PairingExpiredError = errorSchema("pairing_expired", z.object({})).meta({
  description: "The pairing code has expired; mint a new one.",
});
/** The code was issued, and has been exchanged already. */
export const PairingUsedError = errorSchema("pairing_used", z.object({})).meta({
  description: "The pairing code has been exchanged already; each code is single use.",
});
/** The client speaks another protocol version; the code is kept for a client that speaks this one. */
export const ProtocolMismatchError = errorSchema(
  "protocol_mismatch",
  z.object({ protocolVersion: ProtocolVersion.meta({ description: "The environment's own protocol version." }) }),
).meta({
  description: "The client's protocol version is not the environment's, named in data; the code is not spent.",
});

export type PairingInvalidError = z.infer<typeof PairingInvalidError>;
export type PairingExpiredError = z.infer<typeof PairingExpiredError>;
export type PairingUsedError = z.infer<typeof PairingUsedError>;
export type ProtocolMismatchError = z.infer<typeof ProtocolMismatchError>;

/**
 * What a refused pairing exchange answers: `pairing_invalid` (401),
 * `pairing_expired` or `pairing_used` (410), `protocol_mismatch` (400, before
 * the code is looked at), `invalid_params` for a body that is not a
 * `PairRequest` (400) or too large to be one (413), `rate_limited` when one
 * address exchanges too often (429), `unavailable` before the startup gate
 * (503), `internal` when the environment failed (500).
 */
export const PairError = z
  .discriminatedUnion("code", [
    PairingInvalidError,
    PairingExpiredError,
    PairingUsedError,
    ProtocolMismatchError,
    InvalidParamsError,
    RateLimitedError,
    UnavailableError,
    InternalError,
  ])
  .meta({ description: "Why a pairing exchange was refused." });
export type PairError = z.infer<typeof PairError>;
