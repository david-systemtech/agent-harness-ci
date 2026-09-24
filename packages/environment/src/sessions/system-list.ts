import type { PullRequest, RunEndedPayload, RunStartedPayload, SessionActivity } from "@agent-harness/contracts";
import type { ProjectionDb } from "../event-log/event-log.js";
import type { ColumnWriter, Projection } from "./shelf-list.js";
import type { SessionRow } from "./session-tables.js";

/**
 * How the events other workstreams append change the session-list tables:
 * the summary fields only the system writes, which the auto-settle rules
 * read. The session list owns the fields and these projections; the
 * workstreams own the events and their payloads.
 *
 * - Runs (the adapter's vocabulary, #119): a run started is `running`, and
 *   sets the account and model it runs on from its payload; a run ended is
 *   `idle`, or `parked` while a prompt is still open (one a stop left open,
 *   ADR 0007: a run that ends on its own closes its prompts before its end);
 *   both are activity (`lastActivityAt`). The summary has no `starting` in
 *   phase A: no list-flagged event marks a run's first event, so `running`
 *   holds from the start's commit (the run registry tells the two apart).
 *   These projections write only the system's fields: what a run's start and
 *   end owe the organisation fields (unarchive, unsettle, wake, the override
 *   cleared) are events of their own, appended with the run event
 *   (`activity-companions.ts`). The session's live run is kept beside the
 *   fields (`live_run_id`, no summary field), for the prompts' rule.
 * - Prompts (the permissions workstream's, #130): a prompt opened counts and
 *   parks the session; answered, it counts down and is activity, and the
 *   last one answered leaves `parked` for `running` when a run is live, else
 *   `idle`. A run started while an older prompt is open (one a restart kept)
 *   is `running`, the count kept.
 *
 * One module writes the fields the system owns: `activity` from the run and
 * prompt events together, `parkedPromptCount` from the prompt events alone,
 * `accountId` and `model` from `run.started` alone, `lastActivityAt` from a
 * run's start and end and a prompt's answer.
 * - Pull requests (the forge's to append; payload fixed here): each kept by
 *   its url, linked, synced (added when not yet linked) or unlinked.
 *
 * None of them is an organisation change, so none moves `updatedAt`.
 */

type ActivityRow = Pick<SessionRow, "activity" | "parked_prompt_count" | "live_run_id" | "pull_requests">;

const rowOf = (db: ProjectionDb, id: string): ActivityRow | undefined =>
  db.all<ActivityRow>("SELECT activity, parked_prompt_count, live_run_id, pull_requests FROM sessions WHERE id = ?", id)[0];

const stateOf = (row: ActivityRow | undefined): SessionActivity["state"] | undefined =>
  row === undefined ? undefined : (JSON.parse(row.activity) as SessionActivity).state;

const activity = (state: SessionActivity["state"], since: string): string => JSON.stringify({ state, since } satisfies SessionActivity);

/** The session's pull requests with `change` made to the list, kept by url in the order first linked. */
const pullRequests = (db: ProjectionDb, id: string, change: (list: PullRequest[]) => PullRequest[]): string =>
  JSON.stringify(change(JSON.parse(rowOf(db, id)?.pull_requests ?? "[]") as PullRequest[]));

/** A list with `pullRequest` in place of the one with its url, or added at the end. */
const upsert = (list: PullRequest[], pullRequest: PullRequest): PullRequest[] =>
  list.some((held) => held.url === pullRequest.url) ? list.map((held) => (held.url === pullRequest.url ? pullRequest : held)) : [...list, pullRequest];

/** The projections of the run, prompt and pull-request events, writing through the projector's `setColumns`. */
export const systemProjections = (setColumns: ColumnWriter): Readonly<Record<string, Projection>> => ({
  "run.started": (event, db) => {
    const payload = event.payload as RunStartedPayload;
    setColumns(event, db, {
      activity: activity("running", event.occurredAt),
      live_run_id: payload.runId,
      last_activity_at: event.occurredAt,
      account_id: payload.accountId,
      model: payload.model,
    });
  },
  // A run that ended waits on nothing, unless a prompt a stop left open still waits on a person.
  "run.ended": (event, db) => {
    const row = rowOf(db, event.streamId);
    const { runId } = event.payload as RunEndedPayload;
    const waiting = (row?.parked_prompt_count ?? 0) > 0;
    setColumns(event, db, {
      ...(row?.live_run_id === runId && { live_run_id: null }),
      activity: waiting && stateOf(row) === "parked" ? (row?.activity ?? null) : activity(waiting ? "parked" : "idle", event.occurredAt),
      last_activity_at: event.occurredAt,
    });
  },
  "prompt.opened": (event, db) => {
    const row = rowOf(db, event.streamId);
    setColumns(event, db, {
      parked_prompt_count: (row?.parked_prompt_count ?? 0) + 1,
      activity: stateOf(row) === "parked" ? (row?.activity ?? null) : activity("parked", event.occurredAt),
    });
  },
  // The last prompt answered, a live run goes on and a session with none is idle; a run started since stays running.
  "prompt.answered": (event, db) => {
    const row = rowOf(db, event.streamId);
    const count = Math.max(0, (row?.parked_prompt_count ?? 0) - 1);
    setColumns(event, db, {
      parked_prompt_count: count,
      last_activity_at: event.occurredAt,
      ...(count === 0 && stateOf(row) === "parked" && { activity: activity(row?.live_run_id === null ? "idle" : "running", event.occurredAt) }),
    });
  },
  "session.pull-request-linked": (event, db) =>
    setColumns(event, db, { pull_requests: pullRequests(db, event.streamId, (list) => upsert(list, event.payload as PullRequest)) }),
  "session.pull-request-synced": (event, db) =>
    setColumns(event, db, { pull_requests: pullRequests(db, event.streamId, (list) => upsert(list, event.payload as PullRequest)) }),
  "session.pull-request-unlinked": (event, db) => {
    const { url } = event.payload as { url: string };
    setColumns(event, db, { pull_requests: pullRequests(db, event.streamId, (list) => list.filter((held) => held.url !== url)) });
  },
});
