import { GITHUB_ORIGIN, PRODUCT_NAME, type ForgeKind, type ForgeOrigin, type KindUnsupportedError, type NotAForgeError } from "@agent-harness/contracts";
import { forgeGet, type CallOptions, type ForgeHttpOptions, type Reply } from "./forge-http.js";
import { GITLAB_UNSUPPORTED, SITE_UNRECOGNISED } from "./lines.js";
import { field, nonEmpty } from "./providers.js";

/**
 * Which forge an origin is (forge spec, "Providers"; #313), asked with no
 * credential, in the chosen order, the first route that answers as a forge
 * deciding:
 *
 * 1. github.com is GitHub by its name, and nothing is asked.
 * 2. Forgejo's own version route, `/api/forgejo/v1/version`.
 * 3. The Gitea API's, `/api/v1/version`: Gitea, or Forgejo when its version
 *    carries `+gitea-`, as every Forgejo's does.
 * 4. GitHub Enterprise's meta route, `/api/v3/meta`, with its installed
 *    version.
 * 5. GitLab, in ADR 0033's order: the OpenID discovery document naming
 *    GitLab's own scopes, the version route's 401 body, and the project
 *    list's paging headers. GitLab's forge accounts are milestone 2's.
 *
 * A Forgejo or Gitea that asks every caller to sign in (Forgejo 16 on the
 * primary forge, 2026-09-29) answers its version routes 403 with its own
 * line, which tells its kind and no version. A route that does not answer,
 * or answers that it cannot now (a server error, a rate limit), ends
 * detection unreachable: the kind it would have told is not known.
 */

export type Detection =
  /** A forge the harness adds forge accounts for, and the version it answered; null where it gives none. */
  | { readonly outcome: "detected"; readonly kind: Exclude<ForgeKind, "gitlab">; readonly version: string | null }
  /** GitLab, whose forge accounts are milestone 2's (ADR 0033). */
  | { readonly outcome: "unsupported"; readonly kind: "gitlab" }
  /** The address answered every route, and none as a forge. */
  | { readonly outcome: "not-a-forge" }
  /** A route did not answer, or answered that it could not now: one line saying which. */
  | { readonly outcome: "unreachable"; readonly message: string };

/** A detection that answered, naming no kind the harness reads a forge with: GitLab's, or none. */
export type Unreadable = Extract<Detection, { outcome: "unsupported" | "not-a-forge" }>;

/** Why GitLab at `origin` cannot be read: its forge accounts are milestone 2's, which a person is not told (setup-copy.md §5.6). */
export const kindUnsupported = (origin: ForgeOrigin, kind: "gitlab"): KindUnsupportedError => ({
  code: "kind_unsupported",
  message: GITLAB_UNSUPPORTED,
  data: { origin, kind },
});

/** Why `origin` cannot be read as detection found it: GitLab, whose forge accounts are milestone 2's, or no forge the harness knows. */
export const unreadable = (origin: ForgeOrigin, found: Unreadable): KindUnsupportedError | NotAForgeError =>
  found.outcome === "unsupported"
    ? kindUnsupported(origin, found.kind)
    : {
        code: "not_a_forge",
        message: SITE_UNRECOGNISED,
        data: { origin },
      };

type Answered = Extract<Reply, { outcome: "answered" }>;

/** One route detection asks, and what its answer tells: a detection, or null to ask the next. */
interface Route {
  /** The path and query below the origin. */
  readonly path: string;
  readonly read: (reply: Answered) => Detection | null;
}

/** The line Forgejo's and Gitea's API answers a caller with no credential with, when it asks every caller to sign in (`REQUIRE_SIGNIN_VIEW`). */
const SIGN_IN_REQUIRED = "Only signed in user is allowed to call APIs.";

/** The version a Forgejo or Gitea version route answered; null for any other answer. */
const versionIn = (reply: Answered): string | null => (reply.status === 200 ? nonEmpty(field(reply.body, "version")) : null);

/** Whether the answer is a Forgejo or Gitea API asking every caller to sign in. */
const asksToSignIn = (reply: Answered): boolean => reply.status === 403 && field(reply.body, "message") === SIGN_IN_REQUIRED;

const detected = (kind: Exclude<ForgeKind, "gitlab">, version: string | null): Detection => ({ outcome: "detected", kind, version });

const GITLAB: Detection = { outcome: "unsupported", kind: "gitlab" };

/** Scopes only GitLab's discovery document names: another OpenID provider (a Forgejo, an identity provider) names none of them. */
const GITLAB_SCOPES = ["api", "read_repository"];

const ROUTES: readonly Route[] = [
  {
    path: "/api/forgejo/v1/version",
    read: (reply) => {
      const version = versionIn(reply);
      return version !== null ? detected("forgejo", version) : asksToSignIn(reply) ? detected("forgejo", null) : null;
    },
  },
  {
    path: "/api/v1/version",
    read: (reply) => {
      const version = versionIn(reply);
      // A Forgejo asking every caller to sign in has answered its own route so already: this one is Gitea's.
      if (version === null) return asksToSignIn(reply) ? detected("gitea", null) : null;
      return detected(version.includes("+gitea-") ? "forgejo" : "gitea", version);
    },
  },
  {
    path: "/api/v3/meta",
    read: (reply) =>
      reply.status === 200 && typeof field(reply.body, "verifiable_password_authentication") === "boolean" ? detected("github", nonEmpty(field(reply.body, "installed_version"))) : null,
  },
  {
    path: "/.well-known/openid-configuration",
    read: (reply) => {
      const scopes = field(reply.body, "scopes_supported");
      return reply.status === 200 && Array.isArray(scopes) && GITLAB_SCOPES.every((scope) => scopes.includes(scope)) ? GITLAB : null;
    },
  },
  { path: "/api/v4/version", read: (reply) => (reply.status === 401 && field(reply.body, "message") === "401 Unauthorized" ? GITLAB : null) },
  { path: "/api/v4/projects?per_page=1", read: (reply) => (reply.status === 200 && Array.isArray(reply.body) && reply.headers.has("x-per-page") ? GITLAB : null) },
];

const HEADERS = { accept: "application/json", "user-agent": PRODUCT_NAME };

/** Detects which forge `origin` is, asking its routes in order with no credential. */
export const detectForge = async (origin: ForgeOrigin, http: ForgeHttpOptions, call: CallOptions = {}): Promise<Detection> => {
  if (origin === GITHUB_ORIGIN) return detected("github", null);
  for (const route of ROUTES) {
    const reply = await forgeGet(http, `${origin}${route.path}`, null, HEADERS, call);
    if (reply.outcome === "unanswered") return { outcome: "unreachable", message: `The forge at ${origin} ${reply.message}.` };
    const found = route.read(reply);
    if (found !== null) return found;
  }
  return { outcome: "not-a-forge" };
};
