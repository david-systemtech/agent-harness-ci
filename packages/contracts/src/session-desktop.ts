import { z } from "zod";
import { RunId } from "./adapter.js";
import { RunDesktopResolution, SessionDesktop } from "./desktop-driver.js";
import type { EventTypeEntry } from "./event-types.js";
import { SummaryPatch } from "./sessions.js";

/**
 * The desktop's events on a session's stream (computer spec, "Session field
 * and run resolution"; ADR 0038; #2161): the field set, and what each run's
 * start resolved it to, beside the browser's.
 */

export const SessionDesktopSetPayload = z
  .object({ desktop: SessionDesktop.meta({ description: "The session's desktop now: none, contained or local." }) })
  .meta({ description: "session.desktop.set: the session's desktop was set, by sessions.setDesktop or sessions.create. Its next run resolves it." });
export type SessionDesktopSetPayload = z.infer<typeof SessionDesktopSetPayload>;

export const RunDesktopResolvedPayload = z
  .object({ runId: RunId, ...RunDesktopResolution.shape })
  .meta({
    description: "run.desktop.resolved: the run's desktop, once, after run.policy.resolved and before its first tool call: the field it read, the desktop it drives, and why.",
  });
export type RunDesktopResolvedPayload = z.infer<typeof RunDesktopResolvedPayload>;

/**
 * The desktop's events on a session's stream: `session.desktop.set` changes
 * the summary's `desktop`, so it is `list`-flagged with a patch; a run's
 * resolution changes nothing listed.
 */
export const DESKTOP_SESSION_EVENT_TYPES = {
  "session.desktop.set": { list: true, payload: SessionDesktopSetPayload, patch: SummaryPatch },
  "run.desktop.resolved": { list: false, payload: RunDesktopResolvedPayload },
} as const satisfies Record<string, EventTypeEntry>;
