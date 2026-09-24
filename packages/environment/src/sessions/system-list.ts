import type { PullRequest, RunStartedPayload, SessionActivity } from "@agent-harness/contracts";
import type { ProjectionDb } from "../event-log/event-log.js";
import type { ColumnWriter, Projection } from "./shelf-list.js";
import type { SessionRow } from "./session-tables.js";

/**
 * How the events other workstreams append change the session-list tables:
 * the summary fields only the system writes, which the auto-settle rules
 * read. The session list owns the fields and these projections; the
 * workstreams own the events and their payloads.
 *
 * - Runs (the adapter's vocabulary, #119): a run started is `running`,
 *   and sets the account and model it runs on from its payload; a run
 *   ended is `idle`; both are activity (`lastActivityAt`). The companions a
 *   run start owes the shelf (unsettle, unarchive, wake) are #122's.
 * - Prompts, provisional until #130 (payloads theirs): read from the
 *   event's type and time alone, never its payload. A prompt opened parks
 *   the run and counts; a prompt answered is activity and, the last one
 *   answered, runs a parked run again. A run's end zeroes the count, which
 *   #130's `prompt.answered` (auto `run_ended`) replaces.
 *
 * One module writes the fields the system owns: `activity` from the run and
 * prompt events together, `parkedPromptCount` from the prompt events (and
 * the run's end, until #130), `accountId` and `model` from `run.started`
 * alone, `lastActivityAt` from a run's start and end and a prompt's answer.
 * - Pull requests (the forge's to append; payload fixed here): each kept by
 *   its url, linked, synced (added when not yet linked) or unlinked.
 *
 * None of them is an organisation change, so none moves `updatedAt`.
 *
 * Provisional until #130/#122: replacing the prompt projections needs no
 * migration, since the columns they write are summary fields the tables
 * already have and a rebuild replays the log through whatever projections
 * the environment then has.
 */

type ActivityRow = Pick<SessionRow, "activity" | "parked_prompt_count" | "pull_requests">;

const rowOf = (db: ProjectionDb, id: string): ActivityRow | undefined =>
  db.all<ActivityRow>("SELECT activity, parked_prompt_count, pull_requests FROM sessions WHERE id = ?", id)[0];

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
      last_activity_at: event.occurredAt,
      account_id: payload.accountId,
      model: payload.model,
    });
  },
  // A run that ended waits on nothing. Zeroing the count may drop a question still open after the run; #130 owns the real rule.
  "run.ended": (event, db) =>
    setColumns(event, db, { activity: activity("idle", event.occurredAt), parked_prompt_count: 0, last_activity_at: event.occurredAt }),
  "prompt.opened": (event, db) => {
    const row = rowOf(db, event.streamId);
    const held = row === undefined ? undefined : (JSON.parse(row.activity) as SessionActivity);
    setColumns(event, db, {
      parked_prompt_count: (row?.parked_prompt_count ?? 0) + 1,
      activity: held?.state === "parked" ? row?.activity ?? null : activity("parked", event.occurredAt),
    });
  },
  // The last prompt answered, a parked run goes on; a run that has ended stays idle.
  "prompt.answered": (event, db) => {
    const row = rowOf(db, event.streamId);
    const count = Math.max(0, (row?.parked_prompt_count ?? 0) - 1);
    const held = row === undefined ? undefined : (JSON.parse(row.activity) as SessionActivity);
    const parked = held?.state === "parked";
    setColumns(event, db, {
      parked_prompt_count: count,
      last_activity_at: event.occurredAt,
      ...(count === 0 && parked && { activity: activity("running", event.occurredAt) }),
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
