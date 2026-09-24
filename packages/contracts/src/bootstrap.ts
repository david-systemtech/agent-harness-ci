import { z } from "zod";
import { InternalError, InvalidParamsError, RateLimitedError, UnauthorizedError, UnavailableError } from "./errors.js";
import { ClientSessionId, Timestamp } from "./primitives.js";
import { Ceiling, ScopeSet } from "./scopes.js";

/**
 * The bootstrap grant: how a client of the same OS user on the same machine
 * gets a client session without pairing. The environment writes the grant
 * file, readable by its OS user alone, in its data directory on every start;
 * the client reads it and exchanges the secret at `BOOTSTRAP_PATH` over
 * loopback for a `local` client session. The secret is one-time: the file is
 * rewritten with a fresh one after every exchange.
 */

/** The grant file's name in the environment's data directory. */
export const BOOTSTRAP_GRANT_FILE = "bootstrap-grant.json";

/** Where a local client exchanges the grant's secret: `POST`, over loopback only. */
export const BOOTSTRAP_PATH = "/api/bootstrap";

/** The clients that authenticate through the grant: the desktop window and the terminal UI. */
export const BOOTSTRAP_KINDS = ["desktop", "tui"] as const;
export const BootstrapKind = z.enum(BOOTSTRAP_KINDS).meta({
  description:
    "The kind of local client exchanging the bootstrap grant: desktop (a new exchange replaces the previous desktop's client session) or tui (several run at once; each is revoked an hour after its connection closed).",
});
export type BootstrapKind = z.infer<typeof BootstrapKind>;

/** The grant file's contents. */
export const BootstrapGrant = z
  .object({
    secret: z.string().min(1).meta({ description: "The one-time secret; a fresh one replaces it after each exchange." }),
    address: z
      .object({
        host: z.string().min(1),
        port: z.int().min(1).max(65535),
      })
      .meta({ description: "The environment's loopback address, to reach the exchange and the wire at." }),
  })
  .meta({
    description:
      "The bootstrap grant file the environment writes in its data directory, readable by its OS user alone.",
  });
export type BootstrapGrant = z.infer<typeof BootstrapGrant>;

/** The body of `POST /api/bootstrap`. */
export const BootstrapRequest = z
  .object({
    secret: z.string().min(1).meta({ description: "The secret from the grant file." }),
    kind: BootstrapKind,
    label: z.string().min(1).max(200).meta({ description: "A name for the client session, for people." }),
  })
  .meta({ description: "A local client's exchange of the bootstrap grant's secret for a local client session." });
export type BootstrapRequest = z.infer<typeof BootstrapRequest>;

/**
 * A client session as an exchange hands it to a client: the token the client
 * sends in `auth`, and what the session may do. The token is opaque: a client
 * stores and sends it and never reads it.
 */
export const ClientSessionCredential = z
  .object({
    token: z.string().min(1).meta({ description: "The client session token, opaque to the client; sent only in auth." }),
    clientSessionId: ClientSessionId,
    scopes: ScopeSet,
    ceiling: Ceiling,
    expiresAt: Timestamp.meta({ description: "When the token expires." }),
  })
  .meta({ description: "A client session as an exchange answers it: its opaque token, id, scopes, ceiling and expiry." });
export type ClientSessionCredential = z.infer<typeof ClientSessionCredential>;

/**
 * What a refused exchange answers: `unauthorized` for a wrong or used secret
 * (401) or a request not over loopback (403), `invalid_params` for a body
 * that is not a `BootstrapRequest` (400), `rate_limited` when one address
 * exchanges too often (429), `unavailable` before the startup gate (503),
 * `internal` when the environment failed (500).
 */
export const BootstrapError = z
  .discriminatedUnion("code", [UnauthorizedError, InvalidParamsError, RateLimitedError, UnavailableError, InternalError])
  .meta({ description: "Why a bootstrap exchange was refused." });
export type BootstrapError = z.infer<typeof BootstrapError>;
