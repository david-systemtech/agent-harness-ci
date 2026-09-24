import { WIRE_PATH, formatHostPort } from "@agent-harness/contracts";

/**
 * The port an environment listens on when none is given: the environment's
 * `DEFAULT_PORT`, which a test holds this to. An address typed without a port
 * means this one.
 */
export const DEFAULT_ENVIRONMENT_PORT = 7433;

const ADDRESS = /^(?:(https?):\/\/)?(\[[0-9a-f:.]+\]|[^\s/:?#[\]@]+)(?::(\d{1,5}))?\/?$/i;

/**
 * An address as David types or a link carries it (`desk`, `desk:7433`,
 * `100.64.0.7:7433`, `[fd7a::1]:7433`, with or without `http://` and a
 * trailing slash) as the one origin a connection keeps:
 * `http://host:port`, lower-cased. Undefined for anything else, a path or
 * query included.
 */
export const parseAddress = (typed: string): string | undefined => {
  const match = ADDRESS.exec(typed.trim());
  if (!match) return undefined;
  const [, scheme = "http", host = "", portText] = match;
  const port = portText === undefined ? DEFAULT_ENVIRONMENT_PORT : Number(portText);
  if (!(port >= 1 && port <= 65535)) return undefined;
  return `${scheme.toLowerCase()}://${host.toLowerCase()}:${port}`;
};

/** The origin of an address the grant file names. */
export const originOf = (address: { readonly host: string; readonly port: number }): string =>
  `http://${formatHostPort(address.host, address.port)}`;

/** Where the wire is at an origin: `ws://host:port/ws`, `wss://` over `https`. */
export const wireUrl = (origin: string): string => `${origin.replace(/^http/, "ws")}${WIRE_PATH}`;
