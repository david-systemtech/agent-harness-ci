import { PROMPT_EVENT_TYPES, TRANSCRIPT_EVENT_TYPES, type JsonObject, type PullRequest, type SettingsPatch } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../src/event-log/event-log.js";
import type { TestEnvironment } from "./helper.js";
import type { WireClient } from "./wire-client.js";

/**
 * What the shelf's suites share: time in days, the events other
 * workstreams append (runs, #119, and prompts, #130, with the payloads the
 * adapter host and the broker give them; pull requests, the forge's, until it
 * appends them) seeded straight onto the log, and the settings the
 * auto-settle rules read.
 */

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
/** How often the sweep runs. */
export const SWEEP_EVERY = 5 * MINUTE;

/** The actor synthetic run, prompt and pull-request events are appended as, standing in for the adapter and the forge. */
export const SYNTHETIC_ACTOR = "adapter:synthetic";

/** The run each session's seeded `run.started` opened, which its seeded `run.ended` closes. */
const openRuns = new Map<string, string>();

/** The prompts each session's seeded `prompt.opened` opened, oldest first, which its seeded `prompt.answered` answers in turn. */
const openPrompts = new Map<string, { runId: string; promptId: string }[]>();

/**
 * The payload of a run's start or end as the adapter host appends it
 * (checked against the transcript vocabulary): a start on the account
 * `claude-max` and the model `opus`, an end `completed`, the two paired by
 * the session's open run; a prompt's opening and answer as the broker and a
 * person's answer append them, paired oldest first. A run or a prompt is
 * remembered by the ids its payload ends with, `payload`'s over the seeded
 * ones, and an answer naming a prompt answers that one. Any other type is
 * given `payload` as it is.
 */
export const runPayload = (sessionId: string, type: string, payload: JsonObject = {}): JsonObject => {
  if (type === "run.started") {
    const started = TRANSCRIPT_EVENT_TYPES["run.started"].payload.parse({
      runId: randomUUID(),
      accountId: "claude-max",
      identity: null,
      model: "opus",
      effort: null,
      mode: { requested: null, effective: "acceptEdits", clamped: false },
      workspace: { kind: "directory", path: "/work" },
      origin: "client",
      promptMessageId: null,
      queuedMessageIds: [],
      resumedFrom: null,
      forkedFrom: null,
      ...payload,
    });
    openRuns.set(sessionId, started.runId);
    return started;
  }
  if (type === "run.ended") {
    const runId = openRuns.get(sessionId) ?? randomUUID();
    openRuns.delete(sessionId);
    return TRANSCRIPT_EVENT_TYPES["run.ended"].payload.parse({
      runId,
      reason: "completed",
      cause: null,
      error: null,
      usage: null,
      durationMs: 0,
      turnCount: null,
      resultText: null,
      ...payload,
    });
  }
  if (type === "prompt.opened") {
    const opened = PROMPT_EVENT_TYPES["prompt.opened"].payload.parse({
      runId: openRuns.get(sessionId) ?? randomUUID(),
      promptId: randomUUID(),
      kind: "permission",
      toolName: "Bash",
      toolCallId: null,
      input: { command: "ls" },
      summary: "Bash: ls",
      blockedPath: null,
      reason: null,
      questions: null,
      plan: null,
      suggestions: [],
      agentId: null,
      denylist: null,
      mode: "acceptEdits",
      ceiling: "bypassPermissions",
      ttlExpiresAt: null,
      ...payload,
    });
    openPrompts.set(sessionId, [...(openPrompts.get(sessionId) ?? []), { runId: opened.runId, promptId: opened.promptId }]);
    return opened;
  }
  if (type === "prompt.answered") {
    const queued = openPrompts.get(sessionId) ?? [];
    // An answer naming its prompt answers that one; else the oldest open.
    const index = typeof payload["promptId"] === "string" ? queued.findIndex((open) => open.promptId === payload["promptId"]) : 0;
    const prompt = queued[index];
    openPrompts.set(sessionId, queued.filter((_, at) => at !== index));
    return PROMPT_EVENT_TYPES["prompt.answered"].payload.parse({
      runId: prompt?.runId ?? randomUUID(),
      promptId: prompt?.promptId ?? randomUUID(),
      decision: "allow",
      message: null,
      answers: null,
      updatedInput: null,
      mode: null,
      remember: null,
      decidedBy: "cs-synthetic",
      delivery: "live",
      ...payload,
    });
  }
  return payload;
};

/**
 * Appends `type` to the session's stream as the adapter, the broker or the
 * forge would: a run's start and end with the adapter host's payloads, a
 * prompt's with the broker's, a pull request's as given, until the forge
 * appends them.
 */
export const seed = (t: TestEnvironment, sessionId: string, type: string, payload: JsonObject = {}): EventEnvelope[] => [
  ...t.env.log.append({ kind: "session", id: sessionId }, [{ type, payload: runPayload(sessionId, type, payload) }], { actor: SYNTHETIC_ACTOR }).events,
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
