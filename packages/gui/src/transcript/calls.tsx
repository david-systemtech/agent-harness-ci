import {
  TOOL_QUIET_MS,
  classifyTool,
  describeActivity,
  folded,
  formatDuration,
  oneLine,
  outputText,
  summarizeToolInput,
  type ActivityCounts,
  type ToolCallEntry,
  type ToolCategory,
} from "@agent-harness/client-runtime";
import { useState } from "react";
import { Fold } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import type { Revealed } from "../session/pane-documents.js";
import { DocumentTiles } from "./document-tiles.js";
import { Marked } from "./find.js";
import { picturesIn, pictureUrl, withoutPictures } from "./images.js";
import type { RowFacts } from "./rows.js";

/**
 * A run's tool calls (docs/specs/gui.md, "A session pane"; the terminal UI's
 * fold, docs/specs/tui.md): its finished calls folded into one row counting
 * them, which unfolds to each; what is running, failed or was denied stands
 * in full under it. A running call that has said nothing for three minutes
 * (`TOOL_QUIET_MS`, measured by the transcript on the window's clock) turns
 * amber and says for how long: a cue, not a verdict. The pictures the run's
 * calls returned are drawn under them, folded or not, and so is a tile for
 * each document they wrote, which opens it in the Preview. Asked to show one
 * of its calls, the fold opens.
 */

/** The counts of the calls folded into the count row, by category. */
const countsOf = (calls: readonly ToolCallEntry[]): ActivityCounts => {
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const call of calls) {
    const category = classifyTool(call.name);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
};

/** A call's name for people: its title when the provider gives one, else its tool and what it was given. */
const callName = (call: ToolCallEntry): string => {
  if (call.title !== null && call.title.length > 0) return oneLine(call.title, 160);
  const gloss = summarizeToolInput(call.input);
  return gloss.length > 0 ? `${call.name}: ${oneLine(gloss, 140)}` : call.name;
};

/**
 * A fold holding `calls`, and its setter: shut until opened, and opened afresh each time the transcript is asked to show
 * one of them (`revealed`, a new asking each time), however it was left.
 */
export const useOpenedFor = (calls: readonly ToolCallEntry[], revealed: Revealed | null): readonly [boolean, (open: boolean) => void] => {
  const [open, setOpen] = useState(false);
  const [heard, hear] = useState(revealed);
  if (heard !== revealed) {
    hear(revealed);
    if (revealed !== null && calls.some((call) => call.toolCallId === revealed.toolCallId)) setOpen(true);
  }
  return [open, setOpen] as const;
};

interface CallsRowProps {
  readonly calls: readonly ToolCallEntry[];
  readonly facts: RowFacts;
}

export const CallsRow = ({ calls, facts }: CallsRowProps) => {
  const { quietMs } = facts;
  const [open, setOpen] = useOpenedFor(calls.filter(folded), facts.revealed);
  const done = calls.filter(folded);
  const standing = calls.filter((call) => !folded(call));
  const summary = describeActivity(countsOf(done));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {summary.length > 0 && (
        <Fold open={open} onOpenChange={setOpen} summary={<Marked text={summary} />}>
          <div className="flex flex-col gap-1.5 pl-3">
            {done.map((call) => (
              <CallCard key={call.toolCallId} call={call} quietMs={0} />
            ))}
          </div>
        </Fold>
      )}
      {standing.map((call) => (
        <CallCard key={call.toolCallId} call={call} quietMs={call.status === "running" ? quietMs(call.toolCallId) : 0} />
      ))}
      {calls.flatMap((call) =>
        picturesIn(call.output).map((picture, index) => (
          <img
            key={`${call.toolCallId} ${index}`}
            src={pictureUrl(picture)}
            alt={`Returned by ${callName(call)}`}
            className="max-h-96 max-w-full self-start rounded-md border border-hairline object-contain"
          />
        )),
      )}
      <DocumentTiles calls={calls} workspace={facts.workspace} />
    </div>
  );
};

/** One call: its name, its time, and what became of it; quiet for three minutes, amber. */
export const CallCard = ({ call, quietMs }: { readonly call: ToolCallEntry; readonly quietMs: number }) => {
  const quiet = call.status === "running" && quietMs >= TOOL_QUIET_MS;
  const denied = call.decision?.decision === "denied" ? call.decision : null;
  const name = callName(call);
  // A picture it returned is drawn under the run's calls, not spelt out here; the words beside it are.
  const output = outputText(withoutPictures(call.output)).trim();
  return (
    <div
      role="group"
      aria-label={name}
      // The transcript focuses it when asked to show this call (`transcript.tsx`), and marks it so.
      data-tool-call={call.toolCallId}
      tabIndex={-1}
      className={classes(
        "flex min-w-0 flex-col gap-1 rounded-md border px-2.5 py-1.5 text-[0.85em] outline-none focus:outline-2 focus:outline-beam",
        quiet ? "border-amber text-amber" : call.status === "error" ? "border-signal" : "border-hairline",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={classes("truncate font-mono", !quiet && "text-ink")}>
          <Marked text={name} />
        </span>
        {call.durationMs !== null && call.durationMs >= 1000 && <span className="shrink-0 text-ink-faint">{formatDuration(call.durationMs)}</span>}
      </div>
      {call.status === "running" && (
        <p className={quiet ? "text-amber" : "text-ink-muted"}>
          {quiet ? `No output for ${Math.floor(quietMs / 60_000)} min` : call.update === null ? "Running…" : <Marked text={`Running: ${oneLine(outputText(call.update), 160)}`} />}
        </p>
      )}
      {denied !== null && (
        <p className="text-amber">
          <Marked text={`Denied: ${oneLine(denied.reason, 300)}`} />
        </p>
      )}
      {call.status === "cancelled" && <p className="text-ink-faint">Cancelled</p>}
      {(call.status === "error" || call.status === "ok") && output.length > 0 && (
        <pre className={classes("max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words", call.status === "error" ? "text-signal" : "text-ink-muted")}>
          <Marked text={output} />
        </pre>
      )}
    </div>
  );
};
