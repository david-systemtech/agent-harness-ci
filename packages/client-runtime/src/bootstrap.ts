import {
  BOOTSTRAP_KINDS,
  BOOTSTRAP_PATH,
  ClientSessionCredential,
  type BootstrapKind,
  type ClientSessionCredential as Credential,
  type DiscoveryDocument,
} from "@agent-harness/contracts";
import { originOf } from "./connections/address.js";
import { compareProtocol, readDiscovery } from "./discovery.js";
import type { ClientIdentity, GrantReader, HttpFetch } from "./platform.js";

/**
 * The bootstrap grant, client side (docs/specs/client-runtime.md, "Pairing
 * and the bootstrap grant"): read the grant file the local environment
 * writes, which names the loopback address beside the one-time secret, and
 * exchange the secret at `POST /api/bootstrap` for a `local` client session
 * with every scope and the top ceiling. Done on every start, so each desktop
 * start replaces the previous desktop's client session.
 */

/** What became of the local environment at start. */
export type LocalStatus =
  /** The client reads no grant: a browser tab, or a platform without a grant reader. */
  | { readonly state: "none" }
  /** There was no grant to read: no local environment has started. */
  | { readonly state: "no-grant" }
  | { readonly state: "exchanged"; readonly environmentId: string }
  | { readonly state: "failed"; readonly reason: LocalFailureReason; readonly message: string };

export type LocalFailureReason = "unreachable" | "not-ready" | "protocol-mismatch" | "refused";

export type GrantExchange =
  | { readonly ok: true; readonly origin: string; readonly discovery: DiscoveryDocument; readonly credential: Credential }
  | { readonly ok: false; readonly status: LocalStatus };

const isBootstrapKind = (kind: string): kind is BootstrapKind => (BOOTSTRAP_KINDS as readonly string[]).includes(kind);

/**
 * Reads the grant, checks the environment at its address through discovery,
 * and exchanges the secret. A secret refused as stale (another local client
 * exchanged it first, rotating it) is read again once.
 */
export const exchangeGrant = async (options: {
  readonly fetch: HttpFetch;
  readonly grant: GrantReader | undefined;
  readonly client: ClientIdentity;
  readonly protocolVersion: number;
}): Promise<GrantExchange> => {
  const { fetch, client } = options;
  const kind = client.kind;
  if (!options.grant || !isBootstrapKind(kind)) return { ok: false, status: { state: "none" } };
  const failed = (reason: LocalFailureReason, message: string): GrantExchange => ({ ok: false, status: { state: "failed", reason, message } });

  for (let attempt = 0; ; attempt++) {
    const grant = await options.grant.read();
    if (!grant) return { ok: false, status: { state: "no-grant" } };
    const origin = originOf(grant.address);
    const discovery = await readDiscovery(fetch, origin);
    if (!discovery.ok) return failed("unreachable", discovery.message);
    if (discovery.document.readiness !== "ready") {
      return failed("not-ready", `The local environment is ${discovery.document.readiness}.`);
    }
    const mismatch = compareProtocol(discovery.document.protocolVersion, options.protocolVersion);
    if (mismatch) return failed("protocol-mismatch", mismatch.message);

    let status: number;
    let body: unknown;
    try {
      const response = await fetch(`${origin}${BOOTSTRAP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: grant.secret, kind, label: client.label }),
      });
      status = response.status;
      body = await response.json();
    } catch (error) {
      return failed("unreachable", `Nothing answered at ${origin}: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (status === 200) {
      const credential = ClientSessionCredential.safeParse(body);
      if (credential.success) return { ok: true, origin, discovery: discovery.document, credential: credential.data };
    }
    if (status === 401 && attempt === 0) continue;
    if (status === 503) return failed("not-ready", "The local environment is not ready yet.");
    const message = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["message"] : undefined;
    return failed("refused", `The local environment refused the grant (HTTP ${status})${typeof message === "string" ? `: ${message}` : "."}`);
  }
};
