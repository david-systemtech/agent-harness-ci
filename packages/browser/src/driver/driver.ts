import {
  PAGE_DRIVER_ABILITIES,
  WAIT_FOR_MS,
  addressClassOf,
  addressOf,
  hostOf,
  waitBoundMs,
  type CookieEntry,
  type PageArgs,
  type PageArrival,
  type PageDriver,
  type PageDriverKind,
  type PageKey,
  type PageLocation,
  type PageRefusal,
  type PageResult,
  type PageValue,
  type PageVerb,
  type OneTimeAllowance,
} from "@agent-harness/contracts";
import type { CdpSession } from "../cdp/session.js";
import { locateElement, readStorage, selectFieldContents, showsText } from "./in-page.js";
import { CdpPage, NAVIGATION_SETTLE_MS, RECORD_LIMIT, VIEWPORT, systemDriverClock, type CdpCookie, type DriverClock, type LoadOutcome, type PageJudging } from "./page.js";

/**
 * The CDP page driver (browser spec, "One page driver for three browsers"):
 * the page-driver contract implemented once, as CDP calls and in-page
 * functions over the CDP session interface, for a Chrome through the
 * extension, the headless browser and the browser dock alike. It holds no
 * policy: its host passes the page policy it enforces, and the driver judges
 * every frame's arrival by it.
 *
 * Every verb resolves to its value or to a refusal sentence the model can
 * act on; nothing it does throws. Verbs on one page run one at a time.
 */

/** Where the driver's pages come from: a tab in the group, a browser context, the dock's view. */
export interface PageHost {
  /**
   * The page of `pageKey`, attached. With `make` (the `open` verb) the host
   * makes one when the key has none; without, it answers null for a key
   * with none. A host that cannot give a page rejects with the sentence the
   * model reads: a managed profile's debugger block, other sessions holding
   * the headless browser.
   */
  attach(pageKey: PageKey, make: boolean): Promise<CdpSession | null>;
  /** The driver let go of the page (the `close` verb): the headless browser closes its context; a Chrome's tab and the dock stay for the person. */
  release?(pageKey: PageKey): Promise<void> | void;
}

export interface CdpPageDriverOptions extends PageJudging {
  readonly host: PageHost;
  /** `Network` at attach, whatever the address: the headless browser, whose address rule reads where each document was served from. */
  readonly networkAtAttach?: boolean;
  /** The driver's time, for loads, waits and their bounds; preset the platform's. */
  readonly clock?: DriverClock;
}

/** How often a wait for text looks again. */
const WAIT_POLL_MS = 250;

const KIND_NAMES: { readonly [K in PageDriverKind]: string } = { chrome: "Chrome", headless: "The headless browser", dock: "The browser dock" };

const refused = (reason: string): PageRefusal => ({ ok: false, reason });

const joined = (notices: readonly (string | undefined)[]): string | undefined => {
  const kept = notices.filter((notice): notice is string => notice !== undefined && notice !== "");
  return kept.length === 0 ? undefined : kept.join(" ");
};

const seconds = (ms: number): string => {
  const value = ms / 1_000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} second${value === 1 ? "" : "s"}`;
};

/** What refs need until snapshots are built: the selector. */
const NO_REFS = "Refs come from snapshots, which this browser cannot take yet: name the element by a CSS selector instead.";
const SLOW = `The page had not finished loading after ${seconds(NAVIGATION_SETTLE_MS)}; this is how it was then.`;
/** How many console lines or requests the browser keeps between two reads, as a sentence writes it. */
const KEPT = RECORD_LIMIT.toLocaleString("en-GB");

/** An address as the browser opens it: a bare host gets https, or http for this machine's own names, which serve development without TLS. */
const urlOf = (address: string): string => {
  if (addressOf(address)?.scheme !== null) return address;
  return `${addressClassOf(address) === "loopback" ? "http" : "https"}://${address}`;
};

const siteOf = (url: string): string => hostOf(url) ?? url;

export const cdpPageDriver = (options: CdpPageDriverOptions): PageDriver => {
  const { kind, host } = options;
  const clock = options.clock ?? systemDriverClock;
  const abilities = PAGE_DRIVER_ABILITIES[kind];
  const pages = new Map<PageKey, CdpPage>();
  const queues = new Map<PageKey, Promise<unknown>>();

  /** Runs `work` after every verb before it on the same page. */
  const serially = <T>(pageKey: PageKey, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(pageKey) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    queues.set(pageKey, tail);
    void tail.then(() => {
      if (queues.get(pageKey) === tail) queues.delete(pageKey);
    });
    return run;
  };

  const goneSentence = (reason: string): string => `The page this session had is gone (${reason}). Open it again with browser_open.`;

  /** Forgets a page that has gone, letting go of what is left of its session (a crashed page's target stays attached). */
  const forget = (pageKey: PageKey, page: CdpPage): void => {
    if (pages.get(pageKey) === page) pages.delete(pageKey);
    void page.detach().catch(() => undefined);
  };

  /** The page of `pageKey`, attached, or the sentence that says why there is none. */
  const pageFor = async (pageKey: PageKey, make: boolean): Promise<CdpPage | string> => {
    const known = pages.get(pageKey);
    if (known && known.gone === undefined) return known;
    if (known) {
      forget(pageKey, known);
      if (!make) return goneSentence(known.gone as string);
    }
    let session: CdpSession | null;
    try {
      session = await host.attach(pageKey, make);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (session === null) return "No page is open for this session. Open one with browser_open first.";
    try {
      const page = await CdpPage.attach(session, { ...options, networkAtAttach: options.networkAtAttach ?? false, clock });
      pages.set(pageKey, page);
      return page;
    } catch (error) {
      await session.detach().catch(() => undefined);
      return `The browser could not take hold of the page: ${error instanceof Error ? error.message : String(error)}.`;
    }
  };

  /** Where the page is, as an action answers, with what the call asked for and could not have. */
  const arrival = async (page: CdpPage, args: { readonly snapshot?: object | undefined }, load?: LoadOutcome): Promise<PageResult<"open">> => {
    if (load?.kind === "failed") return refused(`The browser could not load the page: ${load.errorText}.`);
    const value: PageArrival = await page.location();
    const notice = joined([load?.kind === "slow" ? SLOW : undefined, args.snapshot === undefined ? undefined : "No snapshot came with this answer: this browser cannot take one yet."]);
    return { ok: true, value, ...(notice !== undefined && { notice }) };
  };

  const located = async (page: CdpPage, selector: string): Promise<{ readonly x: number; readonly y: number; readonly editable: boolean } | PageRefusal> => {
    const found = await page.callInFrame(page.mainFrame(), locateElement, selector);
    switch (found.kind) {
      case "invalid":
        return refused(`The CSS selector ${selector} is not valid: ${found.message}`);
      case "none":
        return refused(`No element on the page matches the CSS selector ${selector}.`);
      case "hidden":
        return refused(`The element matching ${selector} has no visible part on the page to act on.`);
      case "found":
        return found;
    }
  };

  /** A named address opened in the top frame, once the policy has read it. */
  const goTo = async (page: CdpPage, address: string, args: { readonly snapshot?: object | undefined }, allowance: OneTimeAllowance | undefined): Promise<PageResult<"open">> => {
    const url = urlOf(address);
    const standing = page.standing(url, allowance);
    if (standing.kind === "unsupported") return refused(`The browser opens http and https addresses only, and ${address} is neither.`);
    if (standing.kind === "denylisted") {
      return {
        ok: false,
        reason: `${url} is on the denylist's browser section (${standing.match.entry.pattern}), so the browser did not open it. Only the person can allow it.`,
        denylist: { frame: "top-level", match: standing.match },
      };
    }
    if (standing.kind === "web-store" && kind === "chrome") return refused(`${url} is on the Chrome Web Store, where Chrome lets no extension read or act, so the browser did not open it.`);
    const ruled = options.addressRule?.({ url, topLevel: true });
    if (ruled) return refused(ruled);
    return arrival(page, args, await page.navigate(url));
  };

  type Handler<V extends PageVerb> = (page: CdpPage, args: PageArgs<V>, allowance: OneTimeAllowance | undefined) => Promise<PageResult<V>>;
  const verbs: { readonly [V in Exclude<PageVerb, "close">]: Handler<V> } = {
    open: (page, args, allowance) => (args.url === undefined ? arrival(page, args) : goTo(page, args.url, args, allowance)),
    navigate: (page, args, allowance) => goTo(page, args.url, args, allowance),
    snapshot: async () => refused("This browser cannot take a snapshot yet. Take a screenshot to see the page."),
    read: async () => refused("This browser cannot read a page as text yet. Take a screenshot to see the page."),
    click: async (page, args) => {
      if ("ref" in args.target) return refused(NO_REFS);
      const element = await located(page, args.target.selector);
      if ("ok" in element) return element;
      return arrival(page, args, await page.clickAt(element.x, element.y));
    },
    clickAt: async (page, args) => {
      if (args.x >= VIEWPORT.width || args.y >= VIEWPORT.height) {
        return refused(`The point (${args.x}, ${args.y}) is outside the screenshot, which is ${VIEWPORT.width} by ${VIEWPORT.height} pixels.`);
      }
      return arrival(page, args, await page.clickAt(args.x, args.y));
    },
    type: async (page, args) => {
      if ("ref" in args.target) return refused(NO_REFS);
      const { selector } = args.target;
      const element = await located(page, selector);
      if ("ok" in element) return element;
      const notTyped = refused(`The element matching ${selector} does not take typed text.`);
      if (!element.editable) return notTyped;
      const load = await page.clickAt(element.x, element.y);
      const selected = await page.callInFrame(page.mainFrame(), selectFieldContents, selector);
      if (selected === "gone") return refused(`The element matching ${selector} left the page before it could be typed into.`);
      if (selected === "not-editable") return notTyped;
      if (args.text === "") await page.pressDelete();
      else await page.insertText(args.text);
      return arrival(page, args, load);
    },
    screenshot: async (page) => ({ ok: true, value: { mimeType: "image/jpeg", data: await page.screenshot() } }),
    scroll: async (page, args) => {
      if ("ref" in args.to) return refused(NO_REFS);
      const amount = args.to.amount ?? 1;
      const across = args.to.direction === "left" ? -1 : args.to.direction === "right" ? 1 : 0;
      const down = args.to.direction === "up" ? -1 : args.to.direction === "down" ? 1 : 0;
      await page.wheel(across * amount * VIEWPORT.width, down * amount * VIEWPORT.height);
      return { ok: true, value: await page.location() };
    },
    waitFor: async (page, args) => {
      const { until } = args;
      if ("ref" in until) return refused(NO_REFS);
      const bound = waitBoundMs(until);
      const asked = "ms" in until ? until.ms : (until.timeoutMs ?? WAIT_FOR_MS.preset);
      const clamped = asked > WAIT_FOR_MS.max ? `A wait is at most ${seconds(WAIT_FOR_MS.max)}, so this one waited ${seconds(WAIT_FOR_MS.max)}, not ${seconds(asked)}.` : undefined;
      const waited = (value: PageLocation): PageResult<"waitFor"> => ({ ok: true, value, ...(clamped !== undefined && { notice: clamped }) });
      if ("ms" in until) {
        await page.pause(bound);
        return waited(await page.location());
      }
      const deadline = clock.now().getTime() + bound;
      for (;;) {
        const frames = await page.callInEveryFrame(showsText, until.text);
        if ([...frames.values()].some((frame) => frame.ok && frame.value)) return waited(await page.location());
        const left = deadline - clock.now().getTime();
        if (left <= 0) return refused(`"${until.text}" did not appear on the page within ${seconds(bound)}.${clamped === undefined ? "" : ` ${clamped}`}`);
        await page.pause(Math.min(WAIT_POLL_MS, left));
      }
    },
    console: async (page) => {
      await page.enableDeep();
      const { entries, dropped } = page.takeConsole();
      return { ok: true, value: entries, ...(dropped > 0 && { notice: `The ${dropped} oldest lines were dropped: the browser keeps the latest ${KEPT} between two reads.` }) };
    },
    network: async (page, args) => {
      const recording = page.recordsNetwork;
      await page.enableDeep();
      const { entries, dropped } = page.takeNetwork();
      const value = args.failedOnly === true ? entries.filter((entry) => entry.failure !== undefined || (entry.status ?? 0) >= 400) : entries;
      const notice = joined([
        recording ? undefined : "The network is recorded from this call on: ask again after the page has done what you want to see.",
        dropped > 0 ? `The ${dropped} oldest requests were dropped: the browser keeps the latest ${KEPT} between two reads.` : undefined,
      ]);
      return { ok: true, value, ...(notice !== undefined && { notice }) };
    },
    cookies: async (page) => {
      const { url } = page.mainFrame();
      const values = !abilities.deepReadsByPolicy || deepRead(page, url);
      await page.enableDeep();
      const cookies = (await page.cookies(url)).map((cookie) => cookieEntry(cookie, values));
      const notice = values ? undefined : `Cookie values are left out: ${siteOf(url)} is not a dev site. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read them.`;
      return { ok: true, value: cookies, ...(notice !== undefined && { notice }) };
    },
    storage: async (page) => {
      const { url } = page.mainFrame();
      if (abilities.deepReadsByPolicy && !deepRead(page, url)) {
        return refused(`Storage is read only on dev sites, and ${siteOf(url)} is not one. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read it.`);
      }
      await page.enableDeep();
      return { ok: true, value: await page.callInFrame(page.mainFrame(), readStorage) };
    },
    evaluate: async (page, args) => {
      const { url } = page.mainFrame();
      const standing = page.standing(url);
      if (abilities.deepReadsByPolicy && !((standing.kind === "dev-site" || standing.kind === "ordinary") && standing.evaluate)) {
        return refused(`evaluate runs only on dev sites, and ${siteOf(url)} is not one. Add it to browser.devSites, or turn on browser.evaluateEverywhere, to run it.`);
      }
      await page.enableDeep();
      const outcome = await page.evaluate(args.expression);
      if ("threw" in outcome) return refused(`The expression threw: ${outcome.threw}`);
      return { ok: true, value: { result: outcome.value as PageValue<"evaluate">["result"] } };
    },
  };

  const run = async <V extends PageVerb>(pageKey: PageKey, verb: V, args: PageArgs<V>, allowance: OneTimeAllowance | undefined): Promise<PageResult<V>> => {
    if (verb === "close") {
      const page = pages.get(pageKey);
      pages.delete(pageKey);
      if (page && page.gone === undefined) await page.detach().catch(() => undefined);
      await host.release?.(pageKey);
      return { ok: true, value: null } as PageResult<V>;
    }
    const page = await pageFor(pageKey, verb === "open");
    if (typeof page === "string") return refused(page);
    page.beginVerb(allowance);
    try {
      const held = page.takeHeld();
      if (held) return held;
      await page.settleLoading();
      const result = await (verbs[verb as Exclude<PageVerb, "close">] as Handler<V>)(page, args, allowance);
      const late = page.takeHeld();
      if (late) return late;
      if (page.gone !== undefined) return refused(goneSentence(page.gone));
      const notice = result.ok ? joined([result.notice, ...page.takeNotices()]) : undefined;
      return result.ok && notice !== undefined ? { ...result, notice } : result;
    } catch (error) {
      const held = page.takeHeld();
      if (held) return held;
      if (page.gone !== undefined) {
        forget(pageKey, page);
        return refused(goneSentence(page.gone));
      }
      throw error;
    } finally {
      page.endVerb();
    }
  };

  return {
    kind,
    async perform(call) {
      const { verb, args } = call.command;
      if (!(abilities.verbs as readonly PageVerb[]).includes(verb)) {
        return refused(`${KIND_NAMES[kind]} has no ${verb} verb: it reads and acts on pages, without the developer tools' console, network, cookies, storage or evaluate.`);
      }
      try {
        return await serially(call.pageKey, () => run(call.pageKey, verb, args, call.allowance));
      } catch (error) {
        return refused(`The browser failed: ${error instanceof Error ? error.message : String(error)}.`);
      }
    },
  };
};

/** Whether cookie values and storage are read at `url` under the host's policy. */
const deepRead = (page: CdpPage, url: string): boolean => {
  const standing = page.standing(url);
  return (standing.kind === "dev-site" || standing.kind === "ordinary") && standing.deepRead;
};

const cookieEntry = (cookie: CdpCookie, withValue: boolean): CookieEntry => ({
  name: cookie.name,
  ...(withValue && { value: cookie.value }),
  domain: cookie.domain,
  path: cookie.path,
  ...(cookie.session !== true && cookie.expires > 0 && { expires: new Date(cookie.expires * 1_000).toISOString() }),
  httpOnly: cookie.httpOnly,
  secure: cookie.secure,
  ...(cookie.sameSite !== undefined && { sameSite: cookie.sameSite }),
});
