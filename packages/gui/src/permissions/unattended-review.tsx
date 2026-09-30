import { NOTHING_TO_REVIEW, markReviewSeen, reviewCountsWords, reviewDenialWords, reviewRanWords, reviewRunWords, type EnvironmentView } from "@agent-harness/client-runtime";
import type { ResultOf, ReviewRun } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { useWrittenOver } from "../settings/settings-values.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { Part } from "../settings/part.js";

/**
 * The Unattended review (permissions spec, "The Unattended review view";
 * #131; #415): `permissions.review.list` from the request cache, each run
 * newest first with when it ran, its session, who ran it, whether anyone was
 * there, its mode and containment, its calls counted and each denial, in the
 * words the terminal UI's `/review` says; and Mark seen, which moves the
 * environment's watermark through the list's head (`permissions.review.seen`,
 * `sessions:write`, so a client without `admin` may mark it), then reads the
 * list again and shows it over the cached one. Clients hold no state of it
 * (ADR 0003).
 */
export const UnattendedReview = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "permissions.review.list", {}), [runtime, environmentId]));
  const [reread, write] = useWrittenOver<ResultOf<"permissions.review.list">>(answer.fetchedAt);
  const [line, setLine] = useState<{ readonly text: string; readonly refused: boolean } | undefined>(undefined);
  const [marking, setMarking] = useState(false);
  const ready = view.phase === "ready";
  const seen = runtime.capability(environmentId, "permissions.review.seen");
  const listed = reread ?? answer.result;

  const mark = (list: ResultOf<"permissions.review.list">) => {
    setMarking(true);
    setLine(undefined);
    void markReviewSeen(runtime, environmentId, list.head, list.runs.length).then(async (marked) => {
      setLine({ text: marked.line, refused: !marked.ok });
      if (marked.ok) {
        const again = await runtime.requests.call(environmentId, "permissions.review.list", {});
        if (again.ok) write(() => again.result);
      }
      setMarking(false);
    });
  };

  return (
    <Part title="Unattended review">
      <p className="text-sm text-ink-muted">The runs nobody attended that called a tool or had one denied, and the attended runs the TTL, the denylist or containment decided in, since the review was last seen.</p>
      {listed === null ? (
        ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the review…" : `The review could not be read: ${answer.error.message}`}</p>
      ) : listed.runs.length === 0 ? (
        <p className="text-sm text-ink-muted">{NOTHING_TO_REVIEW}</p>
      ) : (
        <ul aria-label="Runs" className="flex flex-col gap-2">
          {listed.runs.map((run) => (
            <RunItem key={run.runId} environmentId={environmentId} run={run} />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button disabled={!ready || seen.status === "absent" || marking || listed === null || listed.runs.length === 0} onClick={() => listed !== null && mark(listed)}>
          Mark seen
        </Button>
        {ready && seen.status === "absent" && <p className="text-xs text-ink-faint">{seen.message}</p>}
      </div>
      {line !== undefined && <p className={`text-xs ${line.refused ? "text-signal" : "text-ink-muted"}`}>{line.text}</p>}
    </Part>
  );
};

/** One reviewed run: when it ran and its session, what ran it and how, its calls counted, and each denial. */
const RunItem = ({ environmentId, run }: { readonly environmentId: string; readonly run: ReviewRun }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const list = useObservable(runtime.projections.sessionList);
  const title = list.rows.find((row) => row.environmentId === environmentId && row.summary.id === run.sessionId)?.summary.title ?? run.sessionId;
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <p className="text-ink">
        <span className="text-ink-faint">{reviewRanWords(run, clock.now())} </span>
        <span className="font-semibold">{title}</span> · {reviewRunWords(run)}
      </p>
      <p className="text-xs text-ink-muted">{reviewCountsWords(run.counts)}</p>
      {run.denials.length > 0 && (
        <ul aria-label="Denials" className="flex flex-col gap-0.5 text-xs text-amber">
          {run.denials.map((denial, index) => (
            <li key={denial.toolCallId ?? index}>{reviewDenialWords(denial)}</li>
          ))}
        </ul>
      )}
    </li>
  );
};
