import { BOOTSTRAP_KINDS, BOOTSTRAP_PATH, type BootstrapKind, type ClientSessionCredential, type DiscoveryDocument } from "@agent-harness/contracts";
import { originOf } from "./connections/address.js";
import { checkDiscovery, readDiscovery } from "./discovery.js";
import { postExchange } from "./exchange.js";
import type { ClientIdentity, GrantReader, HttpFetch } from "./platform.js";

/**
 * The bootstrap grant, client side (docs/specs/client-runtime.md, "Pairing
 * and the bootstrap grant"): read the grant file the local environment
 * writes, which names the loopback address beside the one-time secret, and
 * exchange the secret at `POST /api/bootstrap` for a `local` client session
 * with every scope and the top ceiling. Done on every start, so each desktop
 * start replaces the previous desktop's client session.
 */

/** What became of the local environment's grant exchange, at start or on `retryNow`. */
export type LocalStatus =
  /** The client reads no grant: a browser tab, or a platform without a grant reader. */
  | { readonly state: "none" }
  | { readonly state: "exchanged"; readonly environmentId: string }
  | { readonly state: "failed"; readonly reason: LocalFailureReason; readonly message: string };

/**
 * Why the exchange failed, in the connection phases' words: `service-down`
 * (no grant file, or nothing answers at its address), `starting`,
 * `draining`, a protocol refusal saying which side is behind, or `refused`
 * (the environment turned the secret down twice).
 */
export type LocalFailureReason = "service-down" | "starting" | "draining" | "unsupported-client" | "protocol-mismatch" | "refused";

export type GrantExchange =
  | { readonly ok: true; readonly origin: string; readonly discovery: DiscoveryDocument; readonly credential: ClientSessionCredential }
  | { readonly ok: false; readonly status: LocalStatus };

const isBootstrapKind = (kind: string): kind is BootstrapKind => (BOOTSTRAP_KINDS as readonly string[]).includes(kind);

/** Whether this client exchanges a grant at all: a desktop or terminal UI whose platform reads one. */
export const readsGrant = (grant: GrantReader | undefined, client: ClientIdentity): grant is GrantReader =>
  grant !== undefined && isBootstrapKind(client.kind);

/**
 * Reads the grant, checks the environment at its address through discovery,
 * and exchanges the secret. A secret refused as stale (another local client
 * exchanged it first, which rotates it) is read again, once.
 */
export const exchangeGrant = async (options: {
  readonly fetch: HttpFetch;
  readonly grant: GrantReader | undefined;
  readonly client: ClientIdentity;
  readonly protocolVersion: number;
}): Promise<GrantExchange> => {
  const { fetch, client, grant } = options;
  if (!readsGrant(grant, client)) return { ok: false, status: { state: "none" } };
  const failed = (reason: LocalFailureReason, message: string): GrantExchange => ({ ok: false, status: { state: "failed", reason, message } });

  for (let attempt = 0; ; attempt++) {
    const read = await grant.read();
    if (!read) return failed("service-down", "There is no grant file: the local environment's service is not running.");
    const origin = originOf(read.address);
    const discovery = await readDiscovery(fetch, origin);
    if (!discovery.ok) return failed("service-down", discovery.message);
    const check = checkDiscovery(discovery.document, { protocolVersion: options.protocolVersion });
    if (!check.ok) return failed(check.reason === "different-environment" ? "refused" : check.reason, check.message);

    const answer = await postExchange(fetch, `${origin}${BOOTSTRAP_PATH}`, { secret: read.secret, kind: client.kind, label: client.label });
    if (answer.ok) return { ok: true, origin, discovery: discovery.document, credential: answer.credential };
    if (answer.kind === "unreachable") return failed("service-down", answer.message);
    if (answer.status === 401 && attempt === 0) continue;
    if (answer.code === "unavailable") return failed("starting", "The local environment is not ready yet.");
    return failed(
      "refused",
      `The local environment refused the grant (HTTP ${answer.status})${answer.message === undefined ? "." : `: ${answer.message}`}`,
    );
  }
};
