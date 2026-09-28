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
import { Marked } from "./find.js";
import { picturesIn, pictureUrl } from "./images.js";

/**
 * A run's tool calls (docs/specs/gui.md, "A session pane"; the terminal UI's
 * fold, docs/specs/tui.md): its finished calls folded into one row counting
 * them, which unfolds to each; what is running, failed or was denied stands
 * in full under it. A running call that has said nothing for three minutes
 * (`TOOL_QUIET_MS`, measured by the transcript on the window's clock) turns
 * amber and says for how long: a cue, not a verdict. The pictures the run's
 * calls returned are drawn under them, folded or not.
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

interface CallsRowProps {
  readonly calls: readonly ToolCallEntry[];
  /** How long each running call has said nothing, in milliseconds. */
  readonly quietMs: (toolCallId: string) => number;
}

export const CallsRow = ({ calls, quietMs }: CallsRowProps) => {
  const [open, setOpen] = useState(false);
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
    </div>
  );
};

/** One call: its name, its time, and what became of it; quiet for three minutes, amber. */
export const CallCard = ({ call, quietMs }: { readonly call: ToolCallEntry; readonly quietMs: number }) => {
  const quiet = call.status === "running" && quietMs >= TOOL_QUIET_MS;
  const denied = call.decision?.decision === "denied" ? call.decision : null;
  const name = callName(call);
  // A picture it returned is drawn under the run's calls, not spelt out here.
  const output = picturesIn(call.output).length > 0 ? "" : outputText(call.output).trim();
  return (
    <div
      role="group"
      aria-label={name}
      className={classes(
        "flex min-w-0 flex-col gap-1 rounded-md border px-2.5 py-1.5 text-[0.85em]",
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
