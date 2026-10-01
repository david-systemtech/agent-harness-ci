import { pageKeyOf, type PageDriver, type PageDriverKind, type PageKey, type RunBrowserResolution, type SessionBrowser } from "@agent-harness/contracts";
import type { InProcessToolServer } from "../adapter/contract.js";
import type { ChromeChoice } from "./chrome-choice.js";
import { pageTools, type ChosenBrowser, type LiveBrowser } from "./page-tools.js";
import { webReadTool, type WebReader } from "./web-read.js";

/**
 * The `browser` tool server (browser spec, "The tools"): in process, on
 * every run whatever the session's browser, so its tools show as
 * `mcp__browser__<tool>`, a name permission rules and skills can address.
 * It holds `web_read` on every run, and the browser's verbs (#551) where a
 * run's resolved browser is not none, described for its kind. Two runs
 * whose browsers are of one kind are handed the same tools, so a kept
 * provider process serves the later with the server it started with; each
 * call therefore drives the browser of the session's live run, never the
 * run that built the server. A run whose browser is of another kind is
 * handed other tools, and its adapter starts a fresh process for it.
 *
 * A run whose browser is the plain My Chrome has `browser_open` take
 * `browser`, the name of one of the person's Chromes, the agent's answer to
 * the several-Chromes question (#552): recorded on the session, it is the
 * Chrome the rest of the run drives, and its next run resolves it.
 */

export const BROWSER_TOOL_SERVER = "browser";

/** A browser of a kind a driver drives: one a run resolved, none excepted. */
type DrivenBrowser<K extends PageDriverKind = PageDriverKind> = Extract<SessionBrowser, { readonly kind: K }>;

/** What a driver is asked for: the browser the session's live run resolved, the session, and that run. */
export interface DriverRequest<B extends DrivenBrowser = DrivenBrowser> {
  readonly browser: B;
  readonly sessionId: string;
  readonly runId: string;
}

/**
 * The page drivers by kind, asked at each call for the driver of the
 * browser the session's live run resolved: #552 plugs in the paired Chrome,
 * #554 the relay, #555 the headless browser and #558 the dock. A driver
 * holds its pages, so a kind answers the same driver for the same browser.
 * A kind with none answers the model that this environment cannot drive it
 * yet.
 */
export type PageDrivers = { readonly [K in PageDriverKind]?: (request: DriverRequest<DrivenBrowser<K>>) => PageDriver };

/** The session's live run as a call reads it: its id, and the browser it resolved at its start. */
export interface LiveRunBrowser {
  readonly runId: string;
  readonly browser: RunBrowserResolution;
}

/** What the agent's answer to the several-Chromes question is made into: the Chrome it chose for the session, or why not. */
export interface ChromeChoiceAsk {
  readonly sessionId: string;
  readonly runId: string;
  /** The environment whose plain My Chrome the run resolved. */
  readonly environmentId: string;
  readonly name: string;
}

export interface BrowserToolServerOptions {
  readonly reader: WebReader;
  /** The environment the runs are on, whose id is the first half of each session's page key. */
  readonly environmentId: string;
  /** The session's live run, read at each call; null when it has none. */
  readonly live: (sessionId: string) => LiveRunBrowser | null;
  readonly drivers: PageDrivers;
  /** Chooses the Chrome `browser_open`'s `browser` names for the session, recording it as chosen by the agent. */
  readonly chooseChrome: (ask: ChromeChoiceAsk) => ChromeChoice;
}

/** What a run's `browser` server is built for: its session, and the browser the run resolved at its start. */
export interface BrowserServerScope {
  readonly sessionId: string;
  readonly browser: SessionBrowser;
}

/** What the model reads where a kind has no driver here. */
const NO_DRIVER: { readonly [K in PageDriverKind]: string } = {
  chrome: "This environment cannot drive a Chrome yet.",
  headless: "This environment cannot drive its headless browser yet.",
  dock: "This environment cannot drive the browser dock yet.",
};

const NO_RUN: LiveBrowser = { kind: "refused", reason: "This session has no run in progress, so there is no browser to drive." };

/** The driver of `browser` for the session's run, or the sentence why there is none. */
const driverFor = (options: BrowserToolServerOptions, request: DriverRequest): LiveBrowser => {
  // Each kind's seam takes its own browser's shape; the record cannot say so of an index it is read at.
  const driverOf = options.drivers[request.browser.kind] as ((request: DriverRequest) => PageDriver) | undefined;
  if (driverOf === undefined) return { kind: "refused", reason: NO_DRIVER[request.browser.kind] };
  return { kind: "driven", driver: driverOf(request) };
};

/** A call's way to its browser, whose failure is a sentence too. */
const reaching = <T extends LiveBrowser | ChosenBrowser>(reach: () => T): T | LiveBrowser => {
  try {
    return reach();
  } catch (error) {
    return { kind: "refused", reason: `The browser could not be reached: ${error instanceof Error ? error.message : String(error)}.` };
  }
};

/** The Chrome the agent chose in a run whose browser is the plain My Chrome: the rest of that run drives it. */
interface Chosen {
  readonly runId: string;
  readonly chromeId: string;
}

/**
 * The environment's `browser` servers: `web_read`, one tool for every run,
 * and, for a run whose resolved browser is not none, the browser's verbs for
 * the run's session described for its kind. Built once per environment;
 * each run is handed `serverFor` its session and its resolved browser.
 */
export const createBrowserToolServers = (options: BrowserToolServerOptions): ((scope: BrowserServerScope) => InProcessToolServer) => {
  const webRead = webReadTool(options.reader);
  const readerOnly: InProcessToolServer = { name: BROWSER_TOOL_SERVER, external: false, tools: [webRead] };
  /** The address each session's page last reported, across its runs. */
  const addresses = new Map<PageKey, string>();
  /** The Chrome the agent chose, by session, for the run it chose it in. */
  const chosen = new Map<string, Chosen>();

  /** The driver of the browser the session's live run resolved, the plain My Chrome narrowed to the Chrome the agent chose in it; or why there is none. */
  const liveBrowser = (sessionId: string): LiveBrowser => {
    const live = options.live(sessionId);
    if (live === null) return NO_RUN;
    const { browser } = live.browser;
    if (browser.kind === "none") return { kind: "refused", reason: `This run has no browser: ${live.browser.message} Read a plain page with web_read.` };
    const choice = chosen.get(sessionId);
    if (choice !== undefined && choice.runId !== live.runId) chosen.delete(sessionId);
    const narrowed = browser.kind === "chrome" && browser.chromeId === null && choice?.runId === live.runId ? { ...browser, chromeId: choice.chromeId } : browser;
    return driverFor(options, { browser: narrowed, sessionId, runId: live.runId });
  };

  /** The agent's answer to the several-Chromes question: the Chrome it named, recorded on the session, and its driver; or why not. */
  const choose = (sessionId: string, name: string): ChosenBrowser | LiveBrowser => {
    const live = options.live(sessionId);
    if (live === null) return NO_RUN;
    const { browser } = live.browser;
    if (browser.kind !== "chrome" || browser.chromeId !== null) return { kind: "refused", reason: "This run's browser is not My Chrome, so browser_open takes no browser." };
    const choice = options.chooseChrome({ sessionId, runId: live.runId, environmentId: browser.environmentId, name });
    if (!choice.ok) return { kind: "refused", reason: choice.reason };
    chosen.set(sessionId, { runId: live.runId, chromeId: choice.chrome.id });
    const reached = driverFor(options, { browser: { ...browser, chromeId: choice.chrome.id }, sessionId, runId: live.runId });
    return reached.kind === "refused" ? reached : { ...reached, chosen: choice.chrome.name };
  };

  return ({ sessionId, browser }) => {
    if (browser.kind === "none") return readerOnly;
    const tools = pageTools(browser.kind, {
      pageKey: pageKeyOf(options.environmentId, sessionId),
      addresses,
      live: () => reaching(() => liveBrowser(sessionId)),
      // Only the plain My Chrome is a choice among Chromes: a session that names one is never moved by the model.
      ...(browser.kind === "chrome" && browser.chromeId === null && { choose: (name: string) => reaching(() => choose(sessionId, name)) }),
    });
    return { name: BROWSER_TOOL_SERVER, external: false, tools: [webRead, ...tools] };
  };
};
