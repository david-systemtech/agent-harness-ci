import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isLoopbackAddress } from "../auth/bootstrap.js";
import { hostOf } from "./http.js";

/** Where a request came from, as the access log and the exchange rate limit see it. */
export interface ClientAddress {
  readonly address: string | undefined;
  /** The Tailscale login the proxy named, when it named one. */
  readonly login?: string;
}

export type ClientAddressOf = (request: IncomingMessage) => ClientAddress;

/** The header Tailscale Serve, like most proxies, writes the client's address in. */
export const DEFAULT_CLIENT_ADDRESS_HEADER = "x-forwarded-for";

/** The header Tailscale Serve names the tailnet user in; it drops one a client sends, which another proxy need not. */
const LOGIN_HEADER = "tailscale-user-login";

/** The TCP peer: all the environment knows of a client without a proxy in front of it. */
export const peerAddress: ClientAddressOf = (request) => ({ address: request.socket.remoteAddress });

/** The last entry of a list header, the one the nearest proxy appended; undefined when missing or empty. */
const lastEntry = (value: string | readonly string[] | undefined): string | undefined => {
  const entry = (typeof value === "string" ? value : value?.join(","))?.split(",").at(-1)?.trim();
  return entry === "" ? undefined : entry;
};

/**
 * The client of a request that came through the proxy in front of the
 * external web origin (#1809): behind Tailscale Serve every client's TCP peer
 * is loopback. The forwarded address, and the Tailscale login with it, are
 * taken only from a loopback peer whose Host is the web origin's, as the proxy
 * sends; a tailnet or LAN peer reaches the listener directly and could write
 * any header. Anything else, or a header that holds no address, is the peer.
 * The login is read only when no `header` is named, the Serve setup: a proxy
 * named by its header is not Serve, and passes a client's own login header on.
 */
export const forwardedClientAddress = (webOrigin: string | undefined, header?: string): ClientAddressOf => {
  if (webOrigin === undefined) return peerAddress;
  const webHost = new URL(webOrigin).hostname;
  const name = (header ?? DEFAULT_CLIENT_ADDRESS_HEADER).toLowerCase();
  const behindServe = header === undefined;
  return (request) => {
    const peer = peerAddress(request);
    const host = request.headers.host;
    if (!isLoopbackAddress(peer.address) || host === undefined || hostOf(host) !== webHost) return peer;
    const forwarded = lastEntry(request.headers[name]);
    if (forwarded === undefined || isIP(forwarded) === 0) return peer;
    const login = behindServe ? request.headers[LOGIN_HEADER] : undefined;
    return { address: forwarded, ...(typeof login === "string" && login.trim() !== "" && { login: login.trim() }) };
  };
};
