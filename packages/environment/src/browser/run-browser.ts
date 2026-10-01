import type { RunBrowserResolution, SessionBrowser } from "@agent-harness/contracts";

/**
 * A run's browser, resolved at its start (browser spec, "The browser as a
 * session field"; ADR 0014; #550) from the session's field, whether a
 * person is present, the operator's `browser.headless.allowRuns` and
 * whether the environment has a headless browser, and recorded as
 * `run.browser.resolved` beside the run's policy. Fixed for the run: a
 * change to the field applies from the next.
 */

/** Whether this environment has a headless browser a run can drive: yes, or no with why. */
export type HeadlessAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/**
 * Whether the environment has a headless browser now, asked at each run's
 * start: the environment's headless browser answers it (#555, `headless.ts`).
 * The reason is a clause, which the resolution's sentence follows a colon
 * with.
 */
export type HeadlessAvailabilitySeam = () => HeadlessAvailability;

/** The answer of an adapter host given no environment's seam: no headless browser. */
export const noHeadlessBrowser: HeadlessAvailabilitySeam = () => ({ available: false, reason: "this host has none" });

/** What a run's browser is resolved from, beside the settings: the session's field, and whether a person started the run. */
export interface BrowserRequest {
  /** The session's browser; null for none chosen. */
  readonly field: SessionBrowser | null;
  /** Whether a person is present for the run, as its policy resolved it. */
  readonly attended: boolean;
}

/** Resolves a run's browser at its start; the environment's reads its settings and the availability seam. */
export type BrowserSeam = (request: BrowserRequest) => RunBrowserResolution;

/** What the resolution reads besides the request: the operator's switch, and the headless browser's availability. */
export interface BrowserResolutionSettings {
  /** `browser.headless.allowRuns`: off, no run on this environment gets its headless browser. */
  readonly allowRuns: boolean;
  readonly headless: HeadlessAvailability;
}

const NONE: SessionBrowser = { kind: "none" };

/** How a message names a browser a session chose. */
const described = (browser: SessionBrowser): string => {
  switch (browser.kind) {
    case "chrome":
      return browser.chromeId === null ? "My Chrome" : "a paired Chrome";
    case "headless":
      return "this environment's headless browser";
    case "dock":
      return "the browser dock";
    case "none":
      return "no browser";
  }
};

const NOT_ALLOWED = "browser.headless.allowRuns is off, so no run on this environment gets its headless browser.";

/**
 * A run's browser: a Chrome, headless or the dock as the field names it; for
 * none chosen, the headless browser when `allowRuns` is on and one is
 * available, else none. An unattended run never gets a Chrome or the dock,
 * since nobody is there to watch a signed-in browser: a field naming one
 * resolves to none. With `allowRuns` off no run gets the headless browser,
 * a field naming it included.
 */
export const resolveRunBrowser = ({ field, attended }: BrowserRequest, settings: BrowserResolutionSettings): RunBrowserResolution => {
  if (field === null) {
    if (!settings.allowRuns) return { requested: null, browser: NONE, reason: "headless-not-allowed", message: `The session chose no browser, and ${NOT_ALLOWED}` };
    if (!settings.headless.available) {
      return {
        requested: null,
        browser: NONE,
        reason: "headless-unavailable",
        message: `The session chose no browser, and this environment has no headless browser: ${settings.headless.reason}.`,
      };
    }
    return { requested: null, browser: { kind: "headless" }, reason: "default", message: "The session chose no browser, so the run takes this environment's headless browser." };
  }
  if (!attended && (field.kind === "chrome" || field.kind === "dock")) {
    return {
      requested: field,
      browser: NONE,
      reason: "unattended",
      message: `The session chose ${described(field)}, but nobody is present for this run, and only an attended run drives a Chrome or the dock.`,
    };
  }
  if (field.kind === "headless" && !settings.allowRuns) return { requested: field, browser: NONE, reason: "headless-not-allowed", message: NOT_ALLOWED };
  return { requested: field, browser: field, reason: "chosen", message: `The session chose ${described(field)}.` };
};

/** The resolution on the settings' presets (`allowRuns` on) and no headless browser: what the adapter host resolves with unless given its seam. */
export const presetBrowser: BrowserSeam = (request) => resolveRunBrowser(request, { allowRuns: true, headless: noHeadlessBrowser() });
