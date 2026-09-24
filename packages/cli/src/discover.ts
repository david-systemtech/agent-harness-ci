import { DISCOVERY_PATH, DiscoveryDocument } from "@agent-harness/contracts";

/** The loopback address every environment binds (the env spec's "Binding and discovery"). */
export const LOOPBACK = "127.0.0.1";

/** How long `discoverEnvironment` waits for the discovery URL before calling it silent. */
export const DISCOVERY_TIMEOUT_MS = 2000;

/** What answered at the discovery URL: an environment, something else, or nothing. */
export type Discovery =
  | { readonly kind: "environment"; readonly document: DiscoveryDocument }
  | { readonly kind: "other"; readonly detail: string }
  | { readonly kind: "none" };

/** The origin an environment on `port` answers at, as the status lines print it. */
export const environmentAddress = (port: number): string => `http://${LOOPBACK}:${port}`;

/**
 * Asks the discovery URL on loopback `port` who is there. A refused
 * connection or no answer within the timeout is `none`; an answer that is not
 * a discovery document is `other`.
 */
export const discoverEnvironment = async (
  fetch: typeof globalThis.fetch,
  port: number,
  { timeoutMs = DISCOVERY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Discovery> => {
  let response: Response;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetch(`${environmentAddress(port)}${DISCOVERY_PATH}`, { signal, headers: { accept: "application/json" } });
  } catch {
    return { kind: "none" };
  }
  if (!response.ok) return { kind: "other", detail: `it answered HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "other", detail: "its answer is not JSON" };
  }
  const parsed = DiscoveryDocument.safeParse(body);
  if (!parsed.success) return { kind: "other", detail: "its answer is not a discovery document" };
  return { kind: "environment", document: parsed.data };
};
