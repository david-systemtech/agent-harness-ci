import { DISCOVERY_PATH, DiscoveryDocument, PRODUCT_NAME } from "@agent-harness/contracts";
import type { HttpFetch } from "./platform.js";

/** What reading an environment's discovery document came to. */
export type DiscoveryRead =
  | { readonly ok: true; readonly document: DiscoveryDocument }
  | { readonly ok: false; readonly message: string };

/** `GET` the discovery document at `origin`: unauthenticated, answered before the environment is ready. */
export const readDiscovery = async (fetch: HttpFetch, origin: string): Promise<DiscoveryRead> => {
  let status: number;
  let body: unknown;
  try {
    const response = await fetch(`${origin}${DISCOVERY_PATH}`, { method: "GET" });
    status = response.status;
    body = await response.json();
  } catch (error) {
    return { ok: false, message: `Nothing answered at ${origin}: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const document = DiscoveryDocument.safeParse(body);
  if (status !== 200 || !document.success) {
    return { ok: false, message: `${origin} answered, but not as an ${PRODUCT_NAME} environment (HTTP ${status}).` };
  }
  return { ok: true, document: document.data };
};

/**
 * How the environment's protocol version compares with the client's: equal
 * connects; an environment newer than the client blocks with
 * `unsupported-client` (update this client); an older one with
 * `protocol-mismatch` (update the environment).
 */
export const compareProtocol = (
  environment: number,
  client: number,
): { readonly reason: "unsupported-client" | "protocol-mismatch"; readonly message: string } | undefined => {
  if (environment === client) return undefined;
  return environment > client
    ? { reason: "unsupported-client", message: `The environment speaks protocol ${environment} and this client ${client}: update this client.` }
    : { reason: "protocol-mismatch", message: `The environment speaks protocol ${environment} and this client ${client}: update the environment.` };
};
