import { DEFAULT_ENVIRONMENT_PORT, WIRE_PATH, formatHostPort } from "@agent-harness/contracts";

const ADDRESS = /^(?:(https?):\/\/)?(\[[0-9a-f:.]+\]|[^\s/:?#[\]@]+)(?::(\d{1,5}))?\/?$/i;

/**
 * An address as David types or a link carries it (`desk`, `desk:7433`,
 * `100.64.0.7:7433`, `[fd7a::1]:7433`, with or without `http://` and a
 * trailing slash) as the one origin a connection keeps:
 * lower-cased, at `DEFAULT_ENVIRONMENT_PORT` when no HTTP port is given.
 * Explicit HTTPS uses its standard port, omitted from the canonical origin.
 * Undefined for anything else, a path or query included.
 */
export const parseAddress = (typed: string): string | undefined => {
  const match = ADDRESS.exec(typed.trim());
  if (!match) return undefined;
  const [, scheme = "http", host = "", portText] = match;
  const protocol = scheme.toLowerCase();
  const port = portText === undefined ? (protocol === "https" ? 443 : DEFAULT_ENVIRONMENT_PORT) : Number(portText);
  if (!(port >= 1 && port <= 65535)) return undefined;
  const origin = `${protocol}://${host.toLowerCase()}`;
  return protocol === "https" && port === 443 ? origin : `${origin}:${port}`;
};

/** The origin of a host and port, as the grant file names them: an IPv6 address in brackets. */
export const originOf = (address: { readonly host: string; readonly port: number }): string =>
  `http://${formatHostPort(address.host, address.port)}`;

/** Where the wire is at an origin: `ws://host:port/ws`, `wss://` over `https`. */
export const wireUrl = (origin: string): string => `${origin.replace(/^http/, "ws")}${WIRE_PATH}`;
