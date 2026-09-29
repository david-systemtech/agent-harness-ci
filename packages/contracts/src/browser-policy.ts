import { z } from "zod";
import { DenylistEntry, HostPattern, addressOf, hostOf, hostPatternMatches, ipv6Groups, mappedIpv4, type DenylistMatch } from "./denylist.js";

/**
 * The page policy and the standing of an address under it, and the address
 * classes the environment's rules use (browser spec, "The extension, its
 * folder and its listener", "The headless Chromium" and "The denylist on
 * every frame"; ADR 0014, ADR 0024). Pure, and read with the denylist's
 * matcher (#132): `hostOf` reads every address, so `HTTP://PayPal.com.`, a
 * full-width spelling and an IPv4 address in any form stand as the host they
 * reach, and the extension, the drivers and the tool gate cannot come to read
 * one address two ways.
 */

// The address classes --------------------------------------------------------

/**
 * What kind of place a host is, as the environment's address rules read it:
 * `public`, or one of the internal classes (loopback, private, link-local,
 * CGNAT and unique-local addresses, and `.local`, `.internal` and `.lan`
 * names), or `metadata`, the cloud metadata addresses, which are a class of
 * their own because what answers there is the host machine's credentials.
 */
export const ADDRESS_CLASSES = ["public", "loopback", "private", "link-local", "cgnat", "unique-local", "local-name", "metadata"] as const;
export type AddressClass = (typeof ADDRESS_CLASSES)[number];

/**
 * The cloud metadata addresses, by address and by name: 169.254.169.254
 * (AWS, Google Cloud, Azure, Oracle and others), AWS's ECS task credentials
 * at 169.254.170.2 and its IPv6 endpoint fd00:ec2::254, Alibaba Cloud's
 * 100.100.100.200, and Google Cloud's names for its endpoint.
 */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

/** The name suffixes of the local network: mDNS's `.local`, and `.internal` and `.lan`. */
const LOCAL_NAME_SUFFIXES = [".local", ".internal", ".lan"] as const;

const DOTTED_IPV4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

/** The class of an IPv4 address in dotted decimal, as `hostOf` writes one. */
const ipv4Class = (address: string): AddressClass => {
  if (METADATA_HOSTS.has(address)) return "metadata";
  const [, a, b] = (DOTTED_IPV4.exec(address) as RegExpExecArray).map(Number) as [number, number, number];
  // 0.0.0.0/8 is "this host": a connection to it reaches the machine itself.
  if (a === 127 || a === 0) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
};

/** The class of an IPv6 address as `hostOf` writes one, an IPv4-mapped address read as the IPv4 address it stands for. */
const ipv6Class = (address: string): AddressClass => {
  if (METADATA_HOSTS.has(address)) return "metadata";
  const mapped = mappedIpv4(address);
  if (mapped !== null) return ipv4Class(mapped);
  const groups = ipv6Groups(address) as number[];
  const first = groups[0] as number;
  // `::1`, and the unspecified `::`, which reaches the machine itself as 0.0.0.0 does.
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] as number) <= 1) return "loopback";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xfe00) === 0xfc00) return "unique-local";
  return "public";
};

/** The class of a host name, as `hostOf` writes one: lower case, no trailing dot. */
const nameClass = (name: string): AddressClass => {
  if (METADATA_HOSTS.has(name)) return "metadata";
  // Browsers and the platform's resolvers answer `localhost` and every name under it with loopback.
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  if (LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "local-name";
  return "public";
};

/**
 * The class of a host or an address, read as the denylist's matcher reads
 * it (`hostOf`): a URL or a bare host with an optional port, IPv4 in any
 * spelling (`2852039166`, `0xa9fea9fe`, `0251.0376.0251.0376`), an IPv6
 * literal bracketed or bare, an IPv4-mapped IPv6 address as the IPv4 address
 * it reaches, and full-width spellings as ASCII. A name is classed by its
 * spelling alone; what it resolves to is the caller's to class, address by
 * address. Null where the matcher reads no host.
 */
export const addressClassOf = (hostOrAddress: string): AddressClass | null => {
  const host = hostOf(hostOrAddress);
  if (host === null) return null;
  if (host.includes(":")) return ipv6Class(host);
  if (DOTTED_IPV4.test(host)) return ipv4Class(host);
  return nameClass(host);
};

// The page policy ------------------------------------------------------------

/**
 * The page policy an environment sends its paired Chromes (on `ready`, and
 * again on every change), which the extension enforces in the browser against
 * the address a tab has now, before every verb and after every load: the
 * environment's `browser.devSites`, `browser.evaluateEverywhere` and
 * `browser.deepReadEverywhere`, and the enabled entries of its denylist's
 * browser section.
 */
export const PagePolicy = z
  .object({
    devSites: z.array(HostPattern).meta({
      description:
        "browser.devSites: the hosts being developed, as host patterns, where cookie values, storage and evaluate are allowed; loopback, private, link-local, CGNAT and unique-local addresses and .local, .internal and .lan names count without being listed, a cloud metadata address never.",
    }),
    evaluateEverywhere: z.boolean().meta({ description: "browser.evaluateEverywhere: evaluate is allowed on every site, not only dev sites." }),
    deepReadEverywhere: z.boolean().meta({ description: "browser.deepReadEverywhere: cookie values and storage are read on every site, not only dev sites." }),
    browserDomains: z.array(DenylistEntry).meta({
      description: "The enabled entries of the denylist's browser section, in its order: where no verb goes unasked. A disabled entry never matches.",
    }),
  })
  .meta({
    description:
      "The page policy a paired Chrome enforces: the dev sites, the two everywhere switches and the enabled entries of the denylist's browser section. The Chrome Web Store is refused under every policy.",
  });
export type PagePolicy = z.infer<typeof PagePolicy>;

/**
 * A person's allow of a denylisted address, carried on one verb: it opens
 * that one host, once. The driver spends it on the load it opens.
 */
export const OneTimeAllowance = z
  .object({ host: z.string().min(1).max(1024).meta({ description: "The host the person allowed, in any spelling the denylist's matcher reads." }) })
  .meta({ description: "A one-time allowance: a person allowed this host on this call, so it may be opened once though the denylist lists it." });
export type OneTimeAllowance = z.infer<typeof OneTimeAllowance>;

/**
 * The Chrome Web Store's hosts, their subdomains too: Chrome forbids an
 * extension to read or act there, whatever any policy says, so a page there
 * would be one no verb can use.
 */
const WEB_STORE = ["*.chromewebstore.google.com", "*.chrome.google.com"] as const;

/**
 * What a page policy says about an address:
 *
 * - `unsupported`: no http or https page (a `javascript:`, `file:`,
 *   `chrome:` or `about:` address, or one with no host);
 * - `web-store`: the Chrome Web Store, refused under every policy;
 * - `denylisted`: the first enabled entry of the browser section that
 *   matches, as the tool gate names a match;
 * - `dev-site`: a host being developed (listed, or loopback, private or of
 *   another internal class, which counts without being listed), where deep
 *   reads and evaluate are allowed;
 * - `ordinary`: anywhere else, deep reads and evaluate as the everywhere
 *   switches say.
 *
 * `spendsAllowance` says the one-time allowance is what opened a listed host,
 * so the driver spends it.
 */
export type AddressStanding =
  | { readonly kind: "unsupported" }
  | { readonly kind: "web-store" }
  | { readonly kind: "denylisted"; readonly match: DenylistMatch }
  | { readonly kind: "dev-site" | "ordinary"; readonly deepRead: boolean; readonly evaluate: boolean; readonly spendsAllowance: boolean };

/**
 * The classes that stand as dev sites without being listed: every internal
 * class. A cloud metadata address is not one: nobody develops the host's
 * credentials endpoint.
 */
const UNLISTED_DEV_CLASSES: ReadonlySet<AddressClass> = new Set(["loopback", "private", "link-local", "cgnat", "unique-local", "local-name"]);

/**
 * An address's standing under a page policy, with a one-time allowance when
 * a person allowed a listed host on this call. Read in this order: a page
 * that is no http or https page, the Chrome Web Store, the denylist's browser
 * section (which the allowance opens for its one host), dev sites, and
 * anywhere else. A bare host stands as the page it names, so a missing
 * scheme cannot step round the denylist.
 */
export const standingOf = (address: string, policy: PagePolicy, allowance?: OneTimeAllowance): AddressStanding => {
  const read = addressOf(address);
  if (read === null || read.host === null || (read.scheme !== null && read.scheme !== "http" && read.scheme !== "https")) return { kind: "unsupported" };
  const { host } = read;
  if (WEB_STORE.some((pattern) => hostPatternMatches(pattern, host))) return { kind: "web-store" };
  const allowed = allowance !== undefined && hostOf(allowance.host) === host;
  const entry = policy.browserDomains.find((candidate) => candidate.enabled && hostPatternMatches(candidate.pattern, host));
  if (entry !== undefined && !allowed) return { kind: "denylisted", match: { section: "browserDomains", entry, matched: address } };
  const opened = entry !== undefined;
  const addressClass = addressClassOf(host) as AddressClass;
  if (UNLISTED_DEV_CLASSES.has(addressClass) || policy.devSites.some((pattern) => hostPatternMatches(pattern, host))) {
    return { kind: "dev-site", deepRead: true, evaluate: true, spendsAllowance: opened };
  }
  return { kind: "ordinary", deepRead: policy.deepReadEverywhere, evaluate: policy.evaluateEverywhere, spendsAllowance: opened };
};
