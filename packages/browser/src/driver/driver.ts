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
  type PageSnapshot,
  type PageValue,
  type PageVerb,
  type OneTimeAllowance,
} from "@agent-harness/contracts";
import type { CdpSession } from "../cdp/session.js";
import { frameOwnerKey, installSnapshot, snapshotFrame } from "../snapshot/in-page.js";
import { refGone } from "../snapshot/refs.js";
import { serialiseSnapshot } from "../snapshot/serialiser.js";
import { stitchFrames, type FrameTree } from "../snapshot/stitch.js";
import type { FrameSnapshot, FrameSnapshotOptions } from "../snapshot/world.js";
import { elementShows, frameOwnerOrigin, locateElement, readStorage, scrollToElement, selectFieldContents, showsText, type ElementTarget } from "./in-page.js";
import {
  CdpPage,
  NAVIGATION_SETTLE_MS,
  RECORD_LIMIT,
  VIEWPORT,
  systemDriverClock,
  type CdpCookie,
  type DriverClock,
  type LoadOutcome,
  type PageFrame,
  type PageJudging,
} from "./page.js";

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
  /**
   * The host's own check of an address the agent named (`open` and `navigate`), after the policy's and before the
   * browser opens it: a sentence refuses it, and nothing is opened. The headless browser resolves the name here and
   * judges the addresses it resolves to, which a frame's arrival cannot wait for.
   */
  readonly beforeNavigation?: (url: string) => Promise<string | null>;
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

/** A ref no element has now: what an action by it answers. */
const staleRef = (ref: string): string => `${refGone(ref)} Take a new snapshot and act on the refs it gives.`;
/** What an interactive snapshot with nothing in it answers beside its empty text. */
const NOTHING_TO_ACT_ON = "Nothing on the page can be acted on. Take a snapshot with filter all to read every element.";
const SLOW = `The page had not finished loading after ${seconds(NAVIGATION_SETTLE_MS)}; this is how it was then.`;
/** How many console lines or requests the browser keeps between two reads, as a sentence writes it. */
const KEPT = RECORD_LIMIT.toLocaleString("en-GB");

/** An address as the browser opens it: a bare host gets https, or http for this machine's own names, which serve development without TLS. */
const urlOf = (address: string): string => {
  if (addressOf(address)?.scheme !== null) return address;
  return `${addressClassOf(address) === "loopback" ? "http" : "https"}://${address}`;
};

const siteOf = (url: string): string => hostOf(url) ?? url;

/** An element an action names, as its sentences name it. */
const elementNamed = (target: ElementTarget): string => ("ref" in target ? `The element ${target.ref}` : `The element matching ${target.selector}`);

/** A snapshot's text, its full length and whether it was cut. */
type SnapshotText = Pick<PageSnapshot, "text" | "totalChars" | "truncated">;

/** The frame a ref is from, while the page has it. */
const refFrame = (page: CdpPage, ref: string): PageFrame | undefined => {
  const frameId = page.refs.frameOf(ref);
  return frameId === undefined ? undefined : page.frame(frameId);
};

/** One frame's snapshot, the vendored snapshot sent to its world first when the world has none. */
const frameSnapshot = async (page: CdpPage, frame: PageFrame, options: FrameSnapshotOptions): Promise<FrameSnapshot> => {
  const taken = await page.callInFrame(frame, snapshotFrame, options);
  if (taken !== null) return taken;
  await page.callInFrame(frame, installSnapshot);
  const installed = await page.callInFrame(frame, snapshotFrame, options);
  if (installed === null) throw new Error("The snapshot could not be set up in the frame.");
  return installed;
};

/**
 * The page as a snapshot reads it: every frame in its own isolated world,
 * each numbering its refs past those it gave before, stitched under the
 * iframe that holds it, then serialised as `args` asks. A frame that could
 * not be read is left out and named; a page whose top frame could not be
 * read is refused.
 */
const snapshotOf = async (page: CdpPage, args: PageArgs<"snapshot">): Promise<{ readonly snapshot: SnapshotText; readonly notice: string | undefined } | PageRefusal> => {
  const main = page.mainFrame();
  const outcomes = await page.inEveryFrame((frame) =>
    frameSnapshot(page, frame, { prefix: page.refs.prefixOf(frame.id, frame.id === main.id), firstRef: page.refs.firstRefOf(frame.id) }),
  );
  const top = outcomes.get(main.id);
  if (!top?.ok) return refused(`The browser could not read the page: ${top ? top.error : "its document is gone"}.`);
  const unread: string[] = [];
  const trees = await Promise.all(
    [...outcomes.values()].map(async (outcome): Promise<FrameTree | undefined> => {
      if (!outcome.ok) {
        unread.push(`A frame of the page could not be read (${outcome.frame.url}): ${outcome.error}.`);
        return undefined;
      }
      page.refs.gave(outcome.frame.id, outcome.value.lastRef);
      // A frame whose owner cannot be found (it left the page meanwhile) is left out, as a hidden one is.
      const ownerKey = outcome.frame.id === main.id ? undefined : await page.callOnFrameOwner(outcome.frame, frameOwnerKey).catch(() => undefined);
      const { id, parentId } = outcome.frame;
      return { frameId: id, ...(parentId !== undefined && { parentId }), ...(typeof ownerKey === "number" && { ownerKey }), nodes: outcome.value.nodes };
    }),
  );
  const serialised = serialiseSnapshot(
    stitchFrames(
      main.id,
      trees.filter((tree): tree is FrameTree => tree !== undefined),
    ),
    args,
  );
  if (!serialised.ok) return refused(serialised.reason);
  const { text, totalChars, truncated } = serialised;
  const nothing = text === "" && !truncated && args.filter !== "all" ? NOTHING_TO_ACT_ON : undefined;
  return { snapshot: { text, totalChars, truncated }, notice: joined([...unread, nothing]) };
};

/** Where a frame's viewport starts in the page's: the sum of where each frame's owner iframe holds it, up to the top frame. */
const frameOffset = async (page: CdpPage, frame: PageFrame): Promise<{ readonly x: number; readonly y: number }> => {
  let x = 0;
  let y = 0;
  for (let at: PageFrame | undefined = frame; at?.parentId !== undefined; at = page.frame(at.parentId)) {
    const origin = await page.callOnFrameOwner(at, frameOwnerOrigin);
    if (origin === undefined) break;
    x += origin.x;
    y += origin.y;
  }
  return { x, y };
};

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

  /** Where the page is, as an action answers, with the snapshot the call asked for. */
  const arrival = async (page: CdpPage, args: { readonly snapshot?: PageArgs<"snapshot"> | undefined }, load?: LoadOutcome): Promise<PageResult<"open">> => {
    if (load?.kind === "failed") return refused(`The browser could not load the page: ${load.errorText}.`);
    const location = await page.location();
    const taken = args.snapshot === undefined ? undefined : await snapshotOf(page, args.snapshot);
    const snapshot = taken === undefined || "ok" in taken ? undefined : taken.snapshot;
    const value: PageArrival = { ...location, ...(snapshot !== undefined && { snapshot }) };
    const snapshotNotice = taken === undefined ? undefined : "ok" in taken ? `No snapshot came with this answer: ${taken.reason}` : taken.notice;
    const notice = joined([load?.kind === "slow" ? SLOW : undefined, snapshotNotice]);
    return { ok: true, value, ...(notice !== undefined && { notice }) };
  };

  /**
   * Where an action's element is: the centre of its visible part, scrolled
   * into view in its frame, in the page's viewport (a child frame's offset by
   * where its frames sit), and whether it takes typed text; or the sentence
   * that says why it cannot be acted on.
   */
  const located = async (
    page: CdpPage,
    target: ElementTarget,
  ): Promise<{ readonly frame: PageFrame; readonly x: number; readonly y: number; readonly editable: boolean } | PageRefusal> => {
    const frame = "ref" in target ? refFrame(page, target.ref) : page.mainFrame();
    const what = "ref" in target ? target.ref : target.selector;
    if (frame === undefined) return refused(staleRef(what));
    const found = await page.callInFrame(frame, locateElement, target);
    switch (found.kind) {
      case "invalid":
        return refused(`The CSS selector ${what} is not valid: ${found.message}`);
      case "none":
        return refused(`No element on the page matches the CSS selector ${what}.`);
      case "stale":
        return refused(staleRef(what));
      case "hidden":
        return refused(`${elementNamed(target)} has no visible part on the page to act on.`);
      case "covered":
        return refused(`${elementNamed(target)} is covered at its centre by ${found.by}, which would take the click. Deal with that first, or click at a point.`);
      case "found": {
        // A frame whose owner left the page took the element with it.
        const offset = await frameOffset(page, frame).catch(() => undefined);
        if (offset === undefined) return refused(staleRef(what));
        return { frame, x: found.x + offset.x, y: found.y + offset.y, editable: found.editable };
      }
    }
  };

  /** Whether the element a ref names shows: true, false while it does not yet, or the sentence for a ref no element has. */
  const refShows = async (page: CdpPage, ref: string): Promise<boolean | PageRefusal> => {
    const frame = refFrame(page, ref);
    const shows = frame === undefined ? "stale" : await page.callInFrame(frame, elementShows, ref);
    return shows === "stale" ? refused(staleRef(ref)) : shows === "shown";
  };

  /** Whether any frame of the page shows the text. */
  const textShows = async (page: CdpPage, text: string): Promise<boolean> => {
    const frames = await page.callInEveryFrame(showsText, text);
    return [...frames.values()].some((frame) => frame.ok && frame.value);
  };

  /** A named address opened in the top frame, once the policy has read it. */
  const goTo = async (page: CdpPage, address: string, args: { readonly snapshot?: PageArgs<"snapshot"> | undefined }, allowance: OneTimeAllowance | undefined): Promise<PageResult<"open">> => {
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
    const ruled = options.addressRule?.({ url, topLevel: true }) ?? (await options.beforeNavigation?.(url));
    if (ruled) return refused(ruled);
    return arrival(page, args, await page.navigate(url));
  };

  type Handler<V extends PageVerb> = (page: CdpPage, args: PageArgs<V>, allowance: OneTimeAllowance | undefined) => Promise<PageResult<V>>;
  const verbs: { readonly [V in Exclude<PageVerb, "close">]: Handler<V> } = {
    open: (page, args, allowance) => (args.url === undefined ? arrival(page, args) : goTo(page, args.url, args, allowance)),
    navigate: (page, args, allowance) => goTo(page, args.url, args, allowance),
    snapshot: async (page, args) => {
      const taken = await snapshotOf(page, args);
      if ("ok" in taken) return taken;
      return { ok: true, value: { ...(await page.location()), ...taken.snapshot }, ...(taken.notice !== undefined && { notice: taken.notice }) };
    },
    read: async () => refused("This browser cannot read a page as text yet. Take a screenshot to see the page."),
    click: async (page, args) => {
      const element = await located(page, args.target);
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
      const { target } = args;
      const element = await located(page, target);
      if ("ok" in element) return element;
      const notTyped = refused(`${elementNamed(target)} does not take typed text.`);
      if (!element.editable) return notTyped;
      const load = await page.clickAt(element.x, element.y);
      const selected = await page.callInFrame(element.frame, selectFieldContents, target);
      if (selected === "gone") return refused("ref" in target ? staleRef(target.ref) : `${elementNamed(target)} left the page before it could be typed into.`);
      if (selected === "not-editable") return notTyped;
      if (args.text === "") await page.pressDelete();
      else await page.insertText(args.text);
      return arrival(page, args, load);
    },
    screenshot: async (page) => ({ ok: true, value: { mimeType: "image/jpeg", data: await page.screenshot() } }),
    scroll: async (page, args) => {
      if ("ref" in args.to) {
        const { ref } = args.to;
        const frame = refFrame(page, ref);
        const scrolled = frame === undefined ? "stale" : await page.callInFrame(frame, scrollToElement, ref);
        return scrolled === "stale" ? refused(staleRef(ref)) : { ok: true, value: await page.location() };
      }
      const amount = args.to.amount ?? 1;
      const across = args.to.direction === "left" ? -1 : args.to.direction === "right" ? 1 : 0;
      const down = args.to.direction === "up" ? -1 : args.to.direction === "down" ? 1 : 0;
      await page.wheel(across * amount * VIEWPORT.width, down * amount * VIEWPORT.height);
      return { ok: true, value: await page.location() };
    },
    waitFor: async (page, args) => {
      const { until } = args;
      const bound = waitBoundMs(until);
      const asked = "ms" in until ? until.ms : (until.timeoutMs ?? WAIT_FOR_MS.preset);
      const clamped = asked > WAIT_FOR_MS.max ? `A wait is at most ${seconds(WAIT_FOR_MS.max)}: the ${seconds(asked)} asked for were cut to ${seconds(WAIT_FOR_MS.max)}.` : undefined;
      const waited = (value: PageLocation): PageResult<"waitFor"> => ({ ok: true, value, ...(clamped !== undefined && { notice: clamped }) });
      if ("ms" in until) {
        await page.pause(bound);
        return waited(await page.location());
      }
      const missed =
        "ref" in until ? `The element ${until.ref} did not show on the page within ${seconds(bound)}.` : `"${until.text}" did not appear on the page within ${seconds(bound)}.`;
      const deadline = clock.now().getTime() + bound;
      for (;;) {
        const seen = "ref" in until ? await refShows(page, until.ref) : await textShows(page, until.text);
        if (seen === true) return waited(await page.location());
        if (seen !== false) return seen;
        const left = deadline - clock.now().getTime();
        if (left <= 0) return refused(`${missed}${clamped === undefined ? "" : ` ${clamped}`}`);
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
