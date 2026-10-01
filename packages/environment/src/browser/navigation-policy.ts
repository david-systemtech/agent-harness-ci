import type { FrameArrival } from "@agent-harness/browser";
import { addressOf } from "@agent-harness/contracts";
import { HEADLESS_BROWSER, checkHop, isListedInternal, refusalOf, type AddressRules } from "./address-rules.js";

/**
 * The headless browser's navigation policy (browser spec, "The headless
 * Chromium"; ADR 0014; story 26; #555): the public internet open; loopback,
 * private, link-local, CGNAT and unique-local addresses and `.local`,
 * `.internal` and `.lan` names refused unless listed in
 * `browser.internalHosts`; cloud metadata addresses refused always. The
 * environment's address rules, applied three times: to the name the agent
 * gave and every address it resolves to, before the browser opens it; to the
 * name of every frame's document as it arrives; and to the address that
 * document was actually served from, so a name that resolved to a public
 * address for the check and to a private one for the browser gains nothing.
 * The page driver's frame judge refuses a page whole when one of its frames
 * is refused, and leaves it at about:blank.
 */
export interface NavigationPolicy {
  /** The ruling on a frame's arrival: its host as named, then the address its document was served from. Null when it stands. */
  readonly arrival: (arrival: FrameArrival) => string | null;
  /** The ruling on an address the agent named, its name resolved first. Null when the browser may open it. */
  readonly named: (url: string) => Promise<string | null>;
}

/** The navigation policy under `rules`, read afresh at each ruling: `browser.internalHosts` as it is then, and the resolver. */
export const navigationPolicy = (rules: () => AddressRules): NavigationPolicy => ({
  arrival({ url, topLevel, servedFrom }) {
    const read = addressOf(url);
    // A document no server sends (about:blank, a data: or blob: document) reaches no address.
    if (read === null || read.host === null || (read.scheme !== "http" && read.scheme !== "https")) return null;
    const { host } = read;
    const listed = isListedInternal(rules().internalHosts, host);
    const refused =
      refusalOf(host, null, listed, HEADLESS_BROWSER) ?? (servedFrom === undefined ? null : refusalOf(host, { address: servedFrom, how: "was served from" }, listed, HEADLESS_BROWSER));
    if (refused === null) return null;
    return topLevel ? refused : `A frame of the page loaded ${url}. ${refused}`;
  },
  async named(url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `${url} is no address the headless browser can open.`;
    }
    const ruling = await checkHop(parsed, rules(), HEADLESS_BROWSER);
    return ruling.ok ? null : ruling.reason;
  },
});
