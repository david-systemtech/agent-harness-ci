import { z } from "zod";
import { InternalError, InvalidParamsError, RateLimitedError, UnauthorizedError, errorSchema } from "./errors.js";
import { ForgeOrigin, ForgeSlug } from "./forge.js";

/**
 * The credential route and git's credential helper (forge spec, "The helper
 * and the credential route"; ADR 0020): `agent-harness git-credential
 * <slug>` speaks git's credential protocol and asks the environment's
 * credential route over loopback, proving itself with the run-scoped secret
 * it finds beside the environment's address in two process-only variables.
 * The route serves the canonical origins and verified aliases of the forge
 * accounts that secret names, and nothing else. Its request never carries a
 * password: on `erase` git sends the one it was refused, and the helper
 * leaves it out.
 */

/** Where the helper asks: `POST`, from a loopback socket, the secret as a bearer credential. */
export const GIT_CREDENTIAL_PATH = "/api/internal/git-credential";

/** The variable holding the environment's loopback address and port (`127.0.0.1:7433`), which the helper posts to. */
export const ENVIRONMENT_ADDRESS_VARIABLE = "AGENT_HARNESS_ADDRESS";

/** The variable holding the run-scoped secret: 32 random bytes, base64url, valid while the operation or process it was minted for lives. */
export const RUN_SECRET_VARIABLE = "AGENT_HARNESS_RUN_SECRET";

/** How long the helper waits for the environment's answer before it tells git to quit (a chosen default). */
export const GIT_CREDENTIAL_TIMEOUT_MS = 15_000;

/** git's verbs the helper asks the route about: `get` a credential, or report that one was refused (`erase`). `store` is never asked. */
export const GitCredentialAction = z.enum(["get", "erase"]).meta({
  description: "What git asked the helper: get a credential, or erase one it was refused, which the environment reports and verifies again, forgetting nothing.",
});
export type GitCredentialAction = z.infer<typeof GitCredentialAction>;

/** The body of `POST /api/internal/git-credential`. */
export const GitCredentialRequest = z
  .strictObject({
    action: GitCredentialAction,
    slug: ForgeSlug.meta({ description: "The slug git's configuration named the helper with, which the environment's answers name." }),
    protocol: z.enum(["https", "http"]).meta({ description: "git's protocol attribute: the helper serves git's http transport alone." }),
    host: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[^\s/@\\?#]+$/)
      .meta({ description: "git's host attribute: the host, with its port when the URL had one." }),
  })
  .meta({ description: "What the credential helper asks the environment: git's verb, its own slug, and git's protocol and host." });
export type GitCredentialRequest = z.infer<typeof GitCredentialRequest>;

/** One value of git's credential protocol: a line of its own. */
const ProtocolValue = z.string().min(1).regex(/^[^\n\r\0]+$/);

/** What the route answers a `get` (`erase` is answered 204, with nothing). */
export const GitCredentialAnswer = z
  .object({
    username: ProtocolValue.meta({ description: "git's username, derived per kind: x-access-token for GitHub, the login for Forgejo and Gitea." }),
    password: ProtocolValue.meta({ description: "The forge account's token, read for this request." }),
  })
  .meta({ description: "The credential git gets for the origin: the derived username and the token." });
export type GitCredentialAnswer = z.infer<typeof GitCredentialAnswer>;

/** The origin is served, and its forge account's credential cannot be read now: its problem, in the message. */
export const CredentialUnavailableError = errorSchema(
  "credential_unavailable",
  z.object({ origin: ForgeOrigin.meta({ description: "The origin git asked about." }) }),
).meta({
  description:
    "The forge account serving the origin has no credential to give now (gh or the key manager signed out, the vault entry missing, a copy awaiting one, its login not known yet); the message says which and what to do.",
});
export type CredentialUnavailableError = z.infer<typeof CredentialUnavailableError>;

/**
 * What a refused request answers: `unauthorized` for a missing or unknown
 * secret, one released or voided by a restart, a socket that is not
 * loopback, or an origin no forge account in the secret's set serves (401,
 * or 403 off loopback); `rate_limited` (429); `invalid_params` for a body
 * that is not a `GitCredentialRequest` (400) or too large to be one (413);
 * `credential_unavailable` (503); `internal` (500).
 */
export const GitCredentialError = z
  .discriminatedUnion("code", [UnauthorizedError, RateLimitedError, InvalidParamsError, CredentialUnavailableError, InternalError])
  .meta({ description: "Why the credential route gave git no credential." });
export type GitCredentialError = z.infer<typeof GitCredentialError>;
