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
import { Bot, Check, ChevronRight, CircleX, FilePenLine, FileText, Globe, ListChecks, Plug, Search, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { Fold, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import type { Revealed } from "../session/pane-documents.js";
import { DiffView, editDiff } from "../side-column/diff-view.js";
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
  const [open, setOpen] = useState(() => revealed !== null && calls.some((call) => call.toolCallId === revealed.toolCallId));
  const [heard, hear] = useState(revealed);
  if (heard !== revealed) {
    hear(revealed);
    if (revealed !== null && calls.some((call) => call.toolCallId === revealed.toolCallId)) setOpen(true);
  }
  return [open, setOpen] as const;
};

const CATEGORY_ICONS: Readonly<Record<ToolCategory, LucideIcon>> = {
  command: SquareTerminal, read: FileText, edit: FilePenLine, search: Search,
  web: Globe, agent: Bot, plan: ListChecks, mcp: Plug, other: Wrench,
};

interface CallsRowProps {
  readonly calls: readonly ToolCallEntry[];
  readonly facts: RowFacts;
}

export const CallsRow = ({ calls, facts }: CallsRowProps) => {
  const [choices, setChoices] = useState<Readonly<Record<string, CallChoices>>>({});
  const retain = (id: string, choice: CallChoices) => setChoices((held) => ({ ...held, [id]: choice }));
  const done = calls.filter(folded);
  const [open, setOpen] = useOpenedFor(done, facts.revealed);
  const standing = calls.filter((call) => !folded(call));
  const summary = describeActivity(countsOf(done));
  const categories = [...new Set(done.map((call) => classifyTool(call.name)))].slice(0, 3);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {summary.length > 0 && (
        <Fold open={open} onOpenChange={setOpen} summary={<span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <span aria-hidden="true" className="flex shrink-0 gap-1 text-cyan">{categories.map((category) => { const Icon = CATEGORY_ICONS[category]; return <Icon key={category} className="size-3" />; })}</span>
          <Marked text={summary} />
          <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">{done.length} · {formatDuration(done.reduce((total, call) => total + (call.durationMs ?? 0), 0))}</span>
        </span>}>
          <div className="flex flex-col gap-1.5 pl-3">
            {done.map((call) => <CallCard key={call.toolCallId} call={call} quietMs={0} revealed={facts.revealed} choices={choices[call.toolCallId]} retain={(choice) => retain(call.toolCallId, choice)} />)}
          </div>
        </Fold>
      )}
      {standing.map((call) => <CallCard key={call.toolCallId} call={call} quietMs={call.status === "running" ? facts.quietMs(call.toolCallId) : 0} revealed={facts.revealed} choices={choices[call.toolCallId]} retain={(choice) => retain(call.toolCallId, choice)} />)}
      {calls.flatMap((call) => picturesIn(call.output).map((picture, index) => (
        <img key={`${call.toolCallId} ${index}`} src={pictureUrl(picture)} alt={`Returned by ${callName(call)}`} className="max-h-96 max-w-full self-start rounded-md border border-hairline object-contain" />
      )))}
      {facts.workspace !== null && <DocumentTiles calls={calls} workspace={facts.workspace} />}
    </div>
  );
};

const Raw = ({ text }: { readonly text: string }) => <pre data-tool-raw className="max-h-72 overflow-auto whitespace-pre-wrap break-words border border-hairline bg-wash px-2.5 py-2 font-mono text-2xs leading-relaxed"><Marked text={text} /></pre>;

interface CallChoices {
  readonly expanded: boolean | null;
  readonly inputOpen: boolean | null;
  readonly resultOpen: boolean | null;
}
const INITIAL_CHOICES: CallChoices = { expanded: null, inputOpen: null, resultOpen: null };

/** Expansion and detail choices belong to this call identity, even while its status changes. */
export const CallCard = ({ call, quietMs, revealed = null, choices, retain }: { readonly call: ToolCallEntry; readonly quietMs: number; readonly revealed?: Revealed | null; readonly choices?: CallChoices | undefined; readonly retain?: ((choice: CallChoices) => void) | undefined }) => {
  const quiet = call.status === "running" && quietMs >= TOOL_QUIET_MS;
  const denied = call.decision?.decision === "denied" ? call.decision : null;
  const failed = call.status === "error";
  const name = callName(call);
  const [chosenOpen, setOpen] = useOpenedFor([call], revealed);
  const [localChoices, setLocalChoices] = useState(INITIAL_CHOICES);
  const choice = choices ?? localChoices;
  const keep = retain ?? setLocalChoices;
  const open = chosenOpen || (choice.expanded ?? failed);
  const diff = classifyTool(call.name) === "edit" ? editDiff(call.input) : null;
  const inputOpen = choice.inputOpen ?? (diff === null);
  const resultOpen = choice.resultOpen ?? failed;
  const id = useId();
  const output = outputText(withoutPictures(call.output)).trim();
  const Icon = CATEGORY_ICONS[classifyTool(call.name)];
  const status = denied !== null ? "Denied" : quiet ? `No output for ${Math.floor(quietMs / 60_000)} min` : call.status === "running" ? "Running…" : failed ? "Failed" : call.status === "ok" ? "Done" : "Cancelled";
  const tone = denied !== null || quiet ? "text-amber" : failed ? "text-signal" : call.status === "running" ? "text-cyan" : call.status === "ok" ? "text-mint" : "text-ink-faint";
  return (
    <div role="group" aria-label={name} data-tool-call={call.toolCallId} tabIndex={-1} className={classes(
      "min-w-0 rounded-lg border bg-wash outline-none focus:outline-2 focus:outline-beam",
      quiet ? "border-amber" : failed ? "border-signal/35" : open ? "border-hairline-strong" : "border-hairline",
    )}>
      <Tooltip content={`${open ? "Collapse" : "Expand"} ${name}`} keys="Enter or Space">
        <button type="button" aria-label={name} aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => { setOpen(false); keep({ ...choice, expanded: !open }); }}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-beam">
          <Icon aria-hidden="true" className={classes("size-3.5 shrink-0", tone)} />
          <span className="shrink-0 font-mono text-ink"><Marked text={call.name} /></span>
          <span className="min-w-0 flex-1 truncate text-ink-muted"><Marked text={call.title || summarizeToolInput(call.input)} /></span>
          {diff !== null && <span className="shrink-0 font-mono text-2xs"><span className="text-mint">+{diff.added}</span> <span className="text-signal">-{diff.removed}</span></span>}
          {call.durationMs !== null && <span className="shrink-0 font-mono text-2xs text-ink-faint">{formatDuration(call.durationMs)}</span>}
          <span className={classes("flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-2xs", tone)}>
            {call.status === "running" && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />}
            {call.status === "ok" && denied === null && <Check aria-hidden="true" className="size-3" />}
            {failed && <CircleX aria-hidden="true" className="size-3" />}{status}
          </span>
          <ChevronRight aria-hidden="true" className={classes("size-3 shrink-0 transition-transform duration-100 text-ink-faint", open && "rotate-90")} />
        </button>
      </Tooltip>
      {call.status === "running" && call.update !== null && !quiet && <p className="px-2.5 pb-2 text-xs text-cyan"><Marked text={`Running: ${oneLine(outputText(call.update), 160)}`} /></p>}
      {denied !== null && <p className="px-2.5 pb-2 text-xs text-amber"><Marked text={`Denied: ${oneLine(denied.reason, 300)}`} /></p>}
      {open && <div id={id} className="flex min-w-0 flex-col gap-2 border-t border-hairline px-2.5 py-2 text-xs text-ink-muted">
        {diff !== null && <DiffView text={diff.text} />}
        <Fold summary="Input" open={inputOpen} onOpenChange={(inputOpen) => keep({ ...choice, inputOpen })}><Raw text={JSON.stringify(call.input, null, 2)} /></Fold>
        {output.length > 0 && <Fold summary="Result" open={resultOpen} onOpenChange={(resultOpen) => keep({ ...choice, resultOpen })}><div className={failed ? "text-signal" : "text-ink-muted"}><Raw text={output} /></div></Fold>}
      </div>}
    </div>
  );
};
