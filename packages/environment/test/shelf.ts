import type { JsonObject, PullRequest, SettingsPatch } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../src/event-log/event-log.js";
import type { TestEnvironment } from "./helper.js";
import type { WireClient } from "./wire-client.js";

/**
 * What the shelf's suites share: time in days, the events other
 * workstreams will append (runs and prompts, #119 and #130; pull requests,
 * the forge's) seeded as synthetic events straight onto the log, and the
 * settings the auto-settle rules read.
 */

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
/** How often the sweep runs. */
export const SWEEP_EVERY = 5 * MINUTE;

/** The actor synthetic run, prompt and pull-request events are appended as, standing in for the adapter and the forge. */
export const SYNTHETIC_ACTOR = "adapter:synthetic";

/** Appends `type` to the session's stream as the adapter or the forge would, until #119, #130 and the forge append them. */
export const seed = (t: TestEnvironment, sessionId: string, type: string, payload: JsonObject = {}): EventEnvelope[] => [
  ...t.env.log.append({ kind: "session", id: sessionId }, [{ type, payload }], { actor: SYNTHETIC_ACTOR }).events,
];

/** A pull request in a state, as `session.pull-request-synced` carries it. */
export const pullRequest = (state: PullRequest["state"], at: string, url = "https://git.systemtech.dev:5526/david/agent-harness/pulls/167"): PullRequest => ({
  url,
  state,
  mergedAt: state === "merged" ? at : null,
  closedAt: state === "open" ? null : at,
});

/** Sets settings through `settings.update` as an admin client does; resolves with what its response carries. */
export const updateSettings = (client: WireClient, values: SettingsPatch, commandId = randomUUID()) =>
  client.request("settings.update", { commandId, values });

/** The session and settings events on the log after `sequence`: what the shelf and the settings append, without the access log's. */
export const eventsAfter = (t: TestEnvironment, sequence: number): EventEnvelope[] => t.env.log.readStream({ kinds: ["session", "settings"] }, sequence);

/**
 * Moves time on by `ms` with the client's socket closed, so no socket is
 * pinged through the days, and resolves with a client connected again.
 */
export const pass = async (t: TestEnvironment, client: WireClient, ms: number): Promise<WireClient> => {
  await client.close();
  t.clock.advance(ms);
  return t.client();
};
