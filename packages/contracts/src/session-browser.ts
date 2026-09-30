import { z } from "zod";
import { RunId } from "./adapter.js";
import { BrowserChooser, SessionBrowser } from "./browser-choice.js";
import type { EventTypeEntry } from "./event-types.js";
import { SummaryPatch } from "./sessions.js";

/**
 * The browser's events on a session's stream (browser spec, "The browser as
 * a session field" and "Settings, methods, events and notices"; ADR 0014):
 * the field set, and what each run's start resolved it to.
 */

export const SessionBrowserSetPayload = z
  .object({
    browser: SessionBrowser.nullable().meta({ description: "The session's browser now; null for none chosen, which each run resolves to a default." }),
    chosenBy: BrowserChooser,
  })
  .meta({ description: "session.browser.set: the session's browser was set, by a person, the agent, the reach default or the completions surface. Its next run resolves it." });
export type SessionBrowserSetPayload = z.infer<typeof SessionBrowserSetPayload>;

/**
 * Why a run's browser resolved as it did: the field named it (`chosen`);
 * the field chose none and the run takes the headless browser
 * (`default`); the run is unattended and the field named a Chrome or the
 * dock, which nobody is present to watch (`unattended`); the operator's
 * `browser.headless.allowRuns` is off (`headless-not-allowed`); or the field
 * chose none and the environment has no headless browser
 * (`headless-unavailable`).
 */
export const BROWSER_RESOLUTION_REASONS = ["chosen", "default", "unattended", "headless-not-allowed", "headless-unavailable"] as const;
export const BrowserResolutionReason = z.enum(BROWSER_RESOLUTION_REASONS).meta({
  description:
    "Why a run's browser resolved as it did: chosen (the session's field named it), default (the field chose none, and the run takes the environment's headless browser), unattended (nobody is present, so a Chrome or the dock the field named resolves to none), headless-not-allowed (browser.headless.allowRuns is off), or headless-unavailable (the field chose none and the environment has no headless browser).",
});
export type BrowserResolutionReason = z.infer<typeof BrowserResolutionReason>;

/** What a run's start resolved the session's browser to: fixed for the run, whatever the field says after. */
export const RunBrowserResolution = z
  .object({
    requested: SessionBrowser.nullable().meta({ description: "The session's browser field as the run read it at its start; null for none chosen." }),
    browser: SessionBrowser.meta({ description: "The browser the run may drive: none for no browser." }),
    reason: BrowserResolutionReason,
    message: z.string().min(1).meta({ description: "Why, as a sentence for a person." }),
  })
  .meta({ description: "A run's browser as resolved at its start: the field it read, the browser it gets, and why." });
export type RunBrowserResolution = z.infer<typeof RunBrowserResolution>;

export const RunBrowserResolvedPayload = z
  .object({ runId: RunId, ...RunBrowserResolution.shape })
  .meta({
    description:
      "run.browser.resolved: the run's browser, once, after run.policy.resolved and before its first tool call: the field it read, the browser it gets, and why.",
  });
export type RunBrowserResolvedPayload = z.infer<typeof RunBrowserResolvedPayload>;

/**
 * The browser's events on a session's stream: `session.browser.set` changes
 * the summary's `browser`, so it is `list`-flagged with a patch; a run's
 * resolution changes nothing listed.
 */
export const BROWSER_SESSION_EVENT_TYPES = {
  "session.browser.set": { list: true, payload: SessionBrowserSetPayload, patch: SummaryPatch },
  "run.browser.resolved": { list: false, payload: RunBrowserResolvedPayload },
} as const satisfies Record<string, EventTypeEntry>;
