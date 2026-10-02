import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addressClassOf, hostOf, hostPatternMatches, type AddressClass } from "@agent-harness/contracts";

/**
 * The environment's address rules for `web_read` and the headless browser
 * (browser spec, "`web_read`" and "The headless Chromium"; story 26),
 * applied to every hop of a read and to every address the headless browser
 * opens: the name resolved, an internal address refused unless its host is
 * listed in `browser.internalHosts`, and a cloud metadata address refused
 * always, listed or not. The rules answer the addresses they checked, and a
 * read connects to one of them and to nothing else, so a name that resolves
 * to a public address for the check and a private one a moment later gains
 * nothing: it is never resolved again. The headless browser resolves a name
 * itself, so its navigation policy judges where each document was served
 * from too (`navigation-policy.ts`).
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

/** Who the rules are applied for, as their sentences name it: what it is called, and what it does with an address. */
export interface AddressReader {
  /** Its name inside a sentence, and as a sentence's first words. */
  readonly name: string;
  readonly subject: string;
  /** What it does with an address (`read`), as the sentence's verb takes it: `reads`, and `read` once it has. */
  readonly verb: string;
  readonly does: string;
  readonly done: string;
}

export const WEB_READ: AddressReader = { name: "web_read", subject: "web_read", verb: "read", does: "reads", done: "read" };
export const HEADLESS_BROWSER: AddressReader = { name: "the headless browser", subject: "The headless browser", verb: "open", does: "opens", done: "opened" };

/** How an internal class is named in a sentence. */
const CLASS_NAMES: { readonly [K in Exclude<AddressClass, "public" | "metadata">]: string } = {
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address",
  cgnat: "a carrier-grade NAT address",
  "unique-local": "a unique-local address",
  "local-name": "a local network name",
};

/** An address found for a host: one its name resolves to, or the one a document was served from, which is how a sentence says it. */
export interface FoundAddress {
  readonly address: string;
  readonly how: "resolves to" | "was served from";
}

const metadataRefusal = (host: string, found: FoundAddress | null, reader: AddressReader): string =>
  `${found === null ? host : `${host} ${found.how} ${found.address}, which`} is a cloud metadata address. ${reader.subject} never ${reader.does} one, listed or not: what answers there is the host machine's credentials.`;

const internalRefusal = (host: string, found: FoundAddress | null, addressClass: keyof typeof CLASS_NAMES, reader: AddressReader): string =>
  `${found === null ? `${host} is` : `${host} ${found.how} ${found.address},`} ${CLASS_NAMES[addressClass]}, which ${reader.name} ${reader.does} only when the host is listed in the browser.internalHosts setting. Ask the person to list ${host} there if it should be ${reader.done}.`;

/**
 * The ruling on one address, `host` the name it was found for (the host
 * itself when `found` is null), and `listed` whether the host as named is in
 * `browser.internalHosts`: null when it may be reached.
 */
export const refusalOf = (host: string, found: FoundAddress | null, listed: boolean, reader: AddressReader = WEB_READ): string | null => {
  const addressClass = addressClassOf(found?.address ?? host);
  if (addressClass === "metadata") return metadataRefusal(host, found, reader);
  if (addressClass === null) return `${host} is no address ${reader.name} can ${reader.verb}.`;
  if (addressClass !== "public" && !listed) return internalRefusal(host, found, addressClass, reader);
  return null;
};

/** Whether the host as named is listed in `browser.internalHosts`: what is matched, never an address it resolved to. */
export const isListedInternal = (internalHosts: readonly string[], host: string): boolean => internalHosts.some((pattern) => hostPatternMatches(pattern, host));

/**
 * Checks the host of `url`, an http or https address: the host as named
 * (a metadata name or address refused, an internal one refused unless the
 * host is listed), then, for a name, every address it resolves to, each
 * held to the same rules; a name any of whose addresses is refused is
 * refused whole. Answers the addresses to connect to, in the resolver's
 * order.
 */
export const checkHop = async (url: URL, rules: AddressRules, reader: AddressReader = WEB_READ): Promise<HopRuling> => {
  const host = hostOf(url.href);
  if (host === null) return { ok: false, reason: `${url.href} names no host.` };
  const listed = isListedInternal(rules.internalHosts, host);
  const asNamed = refusalOf(host, null, listed, reader);
  if (asNamed !== null) return { ok: false, reason: asNamed };
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
    const refused = refusalOf(host, { address, how: "resolves to" }, listed, reader);
    if (refused !== null) return { ok: false, reason: refused };
  }
  return { ok: true, addresses };
};
