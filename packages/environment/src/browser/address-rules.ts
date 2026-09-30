import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addressClassOf, hostOf, hostPatternMatches, type AddressClass } from "@agent-harness/contracts";

/**
 * The environment's address rules for `web_read` (browser spec, "`web_read`"
 * and "The headless Chromium"; story 26), applied to every hop of a read:
 * the name resolved, an internal address refused unless its host is listed
 * in `browser.internalHosts`, and a cloud metadata address refused always,
 * listed or not. The rules answer the addresses they checked, and the read
 * connects to one of them and to nothing else, so a name that resolves to a
 * public address for the check and a private one a moment later gains
 * nothing: it is never resolved again.
 */

/** An address a name resolved to, as the connection is made to it. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a host name to every address it has now. */
export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

/** The system's resolver: every address `getaddrinfo` answers, in its order. */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

/** A hop's ruling: the addresses the read may connect to, or the sentence the model reads. */
export type HopRuling = { readonly ok: true; readonly addresses: readonly ResolvedAddress[] } | { readonly ok: false; readonly reason: string };

/** What the rules read beside the address: the listed internal hosts, as `browser.internalHosts` holds them now, and the resolver. */
export interface AddressRules {
  readonly internalHosts: readonly string[];
  readonly resolve: Resolver;
}

/** How an internal class is named in a sentence. */
const CLASS_NAMES: { readonly [K in Exclude<AddressClass, "public" | "metadata">]: string } = {
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address",
  cgnat: "a carrier-grade NAT address",
  "unique-local": "a unique-local address",
  "local-name": "a local network name",
};

const metadataRefusal = (host: string, address: string | null): string =>
  `${address === null ? host : `${host} resolves to ${address}, which`} is a cloud metadata address. web_read never reads one, listed or not: what answers there is the host machine's credentials.`;

const internalRefusal = (host: string, address: string | null, addressClass: keyof typeof CLASS_NAMES): string =>
  `${address === null ? `${host} is` : `${host} resolves to ${address},`} ${CLASS_NAMES[addressClass]}, which web_read reads only when the host is listed in the browser.internalHosts setting. Ask the person to list ${host} there if it should be read.`;

/** The ruling on one address, `host` the name it was found for: null when it may be read. */
const refusalOf = (host: string, address: string | null, listed: boolean): string | null => {
  const addressClass = addressClassOf(address ?? host);
  if (addressClass === "metadata") return metadataRefusal(host, address);
  if (addressClass === null) return `${host} is no address web_read can read.`;
  if (addressClass !== "public" && !listed) return internalRefusal(host, address, addressClass);
  return null;
};

/**
 * Checks the host of `url`, an http or https address: the host as named
 * (a metadata name or address refused, an internal one refused unless the
 * host is listed), then, for a name, every address it resolves to, each
 * held to the same rules; a name any of whose addresses is refused is
 * refused whole. Answers the addresses to connect to, in the resolver's
 * order.
 */
export const checkHop = async (url: URL, rules: AddressRules): Promise<HopRuling> => {
  const host = hostOf(url.href);
  if (host === null) return { ok: false, reason: `${url.href} names no host.` };
  const listed = rules.internalHosts.some((pattern) => hostPatternMatches(pattern, host));
  const named = refusalOf(host, null, listed);
  if (named !== null) return { ok: false, reason: named };
  // A literal address is what the connection reaches; the URL parser writes an IPv6 one in brackets.
  const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(literal);
  if (family !== 0) return { ok: true, addresses: [{ address: literal, family: family === 6 ? 6 : 4 }] };
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await rules.resolve(url.hostname);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
    return { ok: false, reason: `${host} could not be resolved${code}: check the address.` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} resolves to no address: check the address.` };
  for (const { address } of addresses) {
    const refused = refusalOf(host, address, listed);
    if (refused !== null) return { ok: false, reason: refused };
  }
  return { ok: true, addresses };
};
