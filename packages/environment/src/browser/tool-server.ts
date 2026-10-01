import { pageKeyOf, type PageDriver, type PageDriverKind, type PageKey, type RunBrowserResolution, type SessionBrowser } from "@agent-harness/contracts";
import type { InProcessToolServer } from "../adapter/contract.js";
import { pageTools, type LiveBrowser } from "./page-tools.js";
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

export interface BrowserToolServerOptions {
  readonly reader: WebReader;
  /** The environment the runs are on, whose id is the first half of each session's page key. */
  readonly environmentId: string;
  /** The session's live run, read at each call; null when it has none. */
  readonly live: (sessionId: string) => LiveRunBrowser | null;
  readonly drivers: PageDrivers;
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

/** The driver of the browser the session's live run resolved, or the sentence why there is none. */
const liveBrowser = (options: BrowserToolServerOptions, sessionId: string): LiveBrowser => {
  const live = options.live(sessionId);
  if (live === null) return { kind: "refused", reason: "This session has no run in progress, so there is no browser to drive." };
  const { browser } = live.browser;
  if (browser.kind === "none") return { kind: "refused", reason: `This run has no browser: ${live.browser.message} Read a plain page with web_read.` };
  // Each kind's seam takes its own browser's shape; the record cannot say so of an index it is read at.
  const driverOf = options.drivers[browser.kind] as ((request: DriverRequest) => PageDriver) | undefined;
  if (driverOf === undefined) return { kind: "refused", reason: NO_DRIVER[browser.kind] };
  return { kind: "driven", driver: driverOf({ browser, sessionId, runId: live.runId }) };
};

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
  return ({ sessionId, browser }) => {
    if (browser.kind === "none") return readerOnly;
    const tools = pageTools(browser.kind, {
      pageKey: pageKeyOf(options.environmentId, sessionId),
      addresses,
      live: () => {
        try {
          return liveBrowser(options, sessionId);
        } catch (error) {
          return { kind: "refused", reason: `The browser could not be reached: ${error instanceof Error ? error.message : String(error)}.` };
        }
      },
    });
    return { name: BROWSER_TOOL_SERVER, external: false, tools: [webRead, ...tools] };
  };
};
