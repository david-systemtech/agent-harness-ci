import { DISCOVERY_PATH, DiscoveryDocument, PRODUCT_NAME, type HelloFrame } from "@agent-harness/contracts";
import type { HttpFetch, HttpResponse } from "./platform.js";

/** An answer's body as JSON; undefined when it is not JSON (an error page, an empty answer). */
export const readJson = async (response: HttpResponse): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/**
 * What reading an environment's discovery document came to: the document;
 * `unreachable` when nothing answered; `refused` when something answered,
 * but not with a discovery document (a proxy's error page, an empty answer,
 * another service), its HTTP status in the message.
 */
export type DiscoveryRead =
  | { readonly ok: true; readonly document: DiscoveryDocument }
  | { readonly ok: false; readonly kind: "unreachable" | "refused"; readonly message: string };

/** `GET` the discovery document at `origin`: unauthenticated, answered before the environment is ready. */
export const readDiscovery = async (fetch: HttpFetch, origin: string): Promise<DiscoveryRead> => {
  let response: HttpResponse;
  try {
    response = await fetch(`${origin}${DISCOVERY_PATH}`, { method: "GET" });
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `Nothing answered at ${origin}: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const document = DiscoveryDocument.safeParse(await readJson(response));
  if (response.status !== 200 || !document.success) {
    return { ok: false, kind: "refused", message: `${origin} answered, but not as an ${PRODUCT_NAME} environment (HTTP ${response.status}).` };
  }
  return { ok: true, document: document.data };
};

/** Which side of a protocol mismatch is behind: `unsupported-client` (update this client) or `protocol-mismatch` (update the environment). */
export type ProtocolRefusal = "unsupported-client" | "protocol-mismatch";

/**
 * How the environment's protocol version compares with the client's, on
 * discovery, on `hello` and on `bye: protocol` alike: equal connects; an
 * environment newer than the client is `unsupported-client`; an older one
 * `protocol-mismatch`.
 */
export const compareProtocol = (
  environment: number,
  client: number,
): { readonly reason: ProtocolRefusal; readonly message: string } | undefined => {
  if (environment === client) return undefined;
  return environment > client
    ? { reason: "unsupported-client", message: `The environment speaks protocol ${environment} and this client ${client}: update this client.` }
    : { reason: "protocol-mismatch", message: `The environment speaks protocol ${environment} and this client ${client}: update the environment.` };
};

export type DiscoveryRefusal = "starting" | "draining" | ProtocolRefusal | "different-environment";

/**
 * Whether a discovery document lets a client go on: readiness, then the
 * protocol version, then, when one is expected, the environment id. Every
 * check comes before any token is sent. Bootstrap, connect and pairing all
 * read discovery through this.
 */
export const checkDiscovery = (
  document: DiscoveryDocument,
  expect: { readonly protocolVersion: number; readonly environmentId?: string },
): { readonly ok: true } | { readonly ok: false; readonly reason: DiscoveryRefusal; readonly message: string } => {
  if (document.readiness !== "ready") {
    return { ok: false, reason: document.readiness, message: `${document.environmentName} is ${document.readiness}; try again once it is ready.` };
  }
  const mismatch = compareProtocol(document.protocolVersion, expect.protocolVersion);
  if (mismatch) return { ok: false, ...mismatch };
  if (expect.environmentId !== undefined && document.environmentId !== expect.environmentId) {
    return {
      ok: false,
      reason: "different-environment",
      message: `The environment at this address is ${document.environmentName}, not the one this connection was made with.`,
    };
  }
  return { ok: true };
};

/** Whether a `hello` may be used for `environmentId`: it names that environment, and speaks the client's protocol. */
export const admitHello = (
  hello: HelloFrame,
  environmentId: string,
  protocolVersion: number,
): { readonly reason: "different-environment" | ProtocolRefusal; readonly message: string } | undefined => {
  if (hello.environmentId !== environmentId) {
    return { reason: "different-environment", message: `The environment that answered is ${hello.environmentName}, not the one its address named.` };
  }
  return compareProtocol(hello.protocolVersion, protocolVersion);
};
