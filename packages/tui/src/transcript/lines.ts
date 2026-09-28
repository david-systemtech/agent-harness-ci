import type { ToolCallEntry, VerbAvailability } from "@agent-harness/client-runtime";
import type { ModelUsage, RunSummary } from "@agent-harness/contracts";
import {
  classifyTool,
  describeActivity,
  formatDuration,
  formatTokens,
  formatUsd,
  oneLine,
  outputText,
  summarizeToolInput,
  type ActivityCounts,
  type ToolCategory,
} from "./format.js";
import { folded, undoableFold, type Row } from "./rows.js";

/**
 * How a row is drawn (docs/specs/tui.md, "The transcript"): as lines of
 * styled spans, each wrapped to the width the transcript has, in the shape
 * of the provider CLIs' own transcripts: a marker in
 * the gutter, the content hanging under it, what a call returned on a
 * connector. Lines rather than components so the viewport can anchor to the
 * bottom and scroll by lines, and the pager draw the same rows unfolded,
 * without measuring anything Ink laid out.
 *
 * Collapsed (the viewport) a run's finished calls are one count, a cut
 * result shows its head and its tail, and what a rewind cut is one line;
 * unfolded (`expanded`, the pager and a row unfolded with Enter) nothing is
 * held back. A running call quiet for
 * `TOOL_QUIET_MS` turns amber and names the silence.
 */

/** A piece of a line with one style. The last four are a terminal cell's (the pane, a diff tool's colours): Ink's `Text` carries each. */
export interface Span {
  readonly text: string;
  readonly color?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly background?: string;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strikethrough?: boolean;
}

/** Whether two spans are drawn alike, so one may run on into the other. */
export const sameStyle = (a: Omit<Span, "text">, b: Omit<Span, "text">): boolean =>
  a.color === b.color &&
  a.dim === b.dim &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.background === b.background &&
  a.underline === b.underline &&
  a.inverse === b.inverse &&
  a.strikethrough === b.strikethrough;

/** A terminal cell's colour as an emulator or an SGR sequence gives it: a palette index, a 24-bit value, or the default. */
export interface CellColour {
  readonly palette: boolean;
  readonly rgb: boolean;
  readonly value: number;
}

/** A palette entry's colour, as Ink draws it. */
export const paletteColour = (value: number): string => `ansi256(${String(value)})`;

/**
 * The colour Ink draws for a cell's (the terminal pane, a diff tool's
 * colours): a palette entry as `ansi256(n)` (the first sixteen reach the
 * user's terminal as its own palette, and chalk downsamples the rest where
 * the terminal has fewer), a true colour as `#rrggbb`, the default as
 * nothing.
 */
export const colourOf = (colour: CellColour): string | undefined => {
  if (colour.palette) return paletteColour(colour.value);
  if (colour.rgb) return `#${colour.value.toString(16).padStart(6, "0")}`;
  return undefined;
};

/** One line on screen, and the row it belongs to. */
export interface Line {
  readonly row: string;
  readonly spans: readonly Span[];
}

/** How long a running call may say nothing before its row turns amber: a cue, not a verdict. */
export const TOOL_QUIET_MS = 3 * 60_000;

/** How much of a cut result a collapsed row keeps: its first lines say which call it was, its last where it failed. */
export const RESULT_HEAD = 2;
export const RESULT_TAIL = 1;
/** How much of a plan a collapsed row shows before the pager has the rest. */
export const PLAN_LINES = 12;

export interface LineContext {
  /** The columns a line has. */
  readonly width: number;
  /** Nothing folded: every call, every line of every result. */
  readonly expanded: boolean;
  /** How long each running call has been quiet, by tool call id; a call not in it is not quiet. */
  readonly quietMs?: (toolCallId: string) => number;
  /** The key that stops a call (`row.stop`), as the map in force writes it. */
  readonly stopKey?: string;
  /** The plan windows a finished run moved, as words ("1.2% of the 5-hour window"), when known. */
  readonly planDeltas?: (runId: string) => readonly string[];
  /** The key that unfolds a row (`row.unfold`), as the map in force writes it; preset Enter. */
  readonly unfoldKey?: string;
  /**
   * The latest rewind standing (`projections.runs.session`'s `rewound`): the
   * sequence of its fold, whether `sessions.undoRewind` can be used now, and
   * the key that undoes it (`row.rewindUndo`), as the map in force writes it.
   */
  readonly rewound?: { readonly sequence: number; readonly availability: VerbAvailability; readonly key: string };
}

const SPEECH = "●";
const TOOL = "◆";
const INDENT = "  ";

/** Styles by a call's state. Amber for a quiet one: nothing has failed yet. */
const CALL_COLORS: Readonly<Record<string, string>> = { running: "cyan", ok: "green", error: "red", cancelled: "gray", denied: "yellow", quiet: "yellow" };

/** `text` as spans of one style, one per line of it. */
const paragraphs = (text: string, style: Omit<Span, "text"> = {}): Span[][] => text.split("\n").map((line) => [{ ...style, text: line }]);

/**
 * Logical lines wrapped to `width`, breaking after the last space that fits
 * when there is one, each continuation indented by `hang`.
 */
export const wrap = (spans: readonly Span[], width: number, hang = ""): Span[][] => {
  const room = Math.max(1, width);
  const out: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  // The last place a break may go: the span and the offset just past a space.
  let breakAt: { readonly span: number; readonly offset: number } | undefined;
  const push = (style: Span, text: string) => {
    const last = line.at(-1);
    if (last && sameStyle(last, style)) {
      line[line.length - 1] = { ...last, text: last.text + text };
    } else line.push({ ...style, text });
  };
  const newLine = () => {
    out.push(line);
    line = hang.length > 0 ? [{ text: hang }] : [];
    used = [...hang].length;
    breakAt = undefined;
  };
  for (const span of spans) {
    for (const char of span.text) {
      if (used >= room) {
        if (breakAt !== undefined && char !== " ") {
          // Move what came after the last space onto the next line.
          const carried = splitAt(line, breakAt);
          line = carried.head;
          newLine();
          for (const piece of carried.tail) {
            push(piece, piece.text);
            used += [...piece.text].length;
          }
        } else newLine();
        if (char === " ") continue;
      }
      push(span, char);
      used++;
      if (char === " ") breakAt = { span: line.length - 1, offset: (line.at(-1)?.text.length ?? 0) };
    }
  }
  out.push(line);
  return out;
};

/** A line's spans cut at a break: what stays, and what moves to the next line. */
const splitAt = (line: readonly Span[], at: { readonly span: number; readonly offset: number }) => {
  const head: Span[] = line.slice(0, at.span);
  const tail: Span[] = [];
  const cut = line[at.span];
  if (cut) {
    const before = cut.text.slice(0, at.offset).replace(/ +$/, "");
    const after = cut.text.slice(at.offset);
    if (before.length > 0) head.push({ ...cut, text: before });
    if (after.length > 0) tail.push({ ...cut, text: after });
  }
  tail.push(...line.slice(at.span + 1));
  return { head, tail };
};

/**
 * A block: `marker` in the gutter beside the first logical line, the rest
 * hanging under it; each logical line wrapped to the width left.
 */
const block = (row: string, marker: Span, body: readonly (readonly Span[])[], width: number, spaced: boolean): Line[] => {
  const lines: Line[] = spaced ? [{ row, spans: [] }] : [];
  body.forEach((logical, index) => {
    const lead: Span = index === 0 ? { ...marker, text: `${marker.text} ` } : { text: INDENT };
    for (const [n, wrapped] of wrap(logical, width - 2, "").entries()) lines.push({ row, spans: [n === 0 ? lead : { text: INDENT }, ...wrapped] });
  });
  if (body.length === 0) lines.push({ row, spans: [{ ...marker, text: marker.text }] });
  return lines;
};

/** What a call returned, on a connector under it: `⎿` on the first line, lined up under it after. */
const returned = (lines: readonly (readonly Span[])[]): Span[][] =>
  lines.map((spans, index) => [{ text: index === 0 ? "⎿ " : "  ", dim: true }, ...spans]);

/** The non-blank lines of `text`, for a preview. */
const nonBlank = (text: string): string[] => text.split("\n").filter((line) => line.trim().length > 0);

/** Head and tail of `lines` with a count between them, or all of them when that would save nothing or `whole`. */
const cutLines = (lines: readonly string[], whole: boolean, style: Omit<Span, "text"> = { dim: true }): Span[][] => {
  if (whole || lines.length <= RESULT_HEAD + RESULT_TAIL + 1) return lines.map((line) => [{ ...style, text: line }]);
  const hidden = lines.length - RESULT_HEAD - RESULT_TAIL;
  return [
    ...lines.slice(0, RESULT_HEAD).map((line) => [{ ...style, text: line }]),
    [{ dim: true, text: `… +${hidden} line${hidden === 1 ? "" : "s"} · Ctrl+O` }],
    ...lines.slice(-RESULT_TAIL).map((line) => [{ ...style, text: line }]),
  ];
};

/** One call as a block: its mark, its title or name and gloss, its time, and what it returned, cut unless `whole`. */
const callLines = (row: string, call: ToolCallEntry, context: LineContext, whole: boolean, spaced: boolean): Line[] => {
  const quietMs = call.status === "running" ? (context.quietMs?.(call.toolCallId) ?? 0) : 0;
  const quiet = quietMs >= TOOL_QUIET_MS;
  const denied = call.decision?.decision === "denied";
  const state = quiet ? "quiet" : denied ? "denied" : call.status;
  const head: Span[] = [];
  const gloss = summarizeToolInput(call.input);
  if (call.title !== null && call.title.length > 0) head.push({ text: oneLine(call.title, 160), bold: true });
  else {
    head.push({ text: call.name, bold: true });
    if (gloss.length > 0) head.push({ text: `(${oneLine(gloss, 140)})`, dim: true });
  }
  if (call.durationMs !== null && call.durationMs >= 1000) head.push({ text: `  ${formatDuration(call.durationMs)}`, dim: true });
  if (quiet) head.push({ text: ` · no output for ${Math.floor(quietMs / 60_000)}m · ${context.stopKey ?? "x"} stops it`, color: "yellow" });
  const body: Span[][] = [quiet ? head.map((span) => ({ ...span, color: "yellow" })) : head];
  const under: Span[][] = [];
  if (call.status === "running" && call.update !== null) under.push([{ text: oneLine(outputText(call.update), 160), dim: true }]);
  if (denied && call.decision?.decision === "denied") under.push([{ text: `Denied: ${oneLine(call.decision.reason, 300)}`, color: "yellow" }]);
  else if (call.status === "error") under.push(...cutLines(nonBlank(outputText(call.output)), whole, { color: "red" }));
  else if (call.status === "cancelled") under.push([{ text: "Cancelled", dim: true }]);
  else if (call.status === "ok" && whole) under.push(...cutLines(nonBlank(outputText(call.output)), true));
  if (under.length > 0) body.push(...returned(under));
  return block(row, { text: TOOL, color: CALL_COLORS[state] ?? "green" }, body, context.width, spaced);
};

/** The counts of the calls folded into the count row, by category. */
const countsOf = (calls: readonly ToolCallEntry[]): ActivityCounts => {
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const call of calls) {
    const category = classifyTool(call.name);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
};

/** A run's calls: the finished ones as one count, what is running or went wrong under it in full; unfolded, every call under a dim count. */
const callsLines = (row: string, calls: readonly ToolCallEntry[], context: LineContext): Line[] => {
  const done = calls.filter(folded);
  const shown = context.expanded ? calls : calls.filter((call) => !folded(call));
  const summary = describeActivity(countsOf(done));
  const lines: Line[] = [];
  if (summary.length > 0) lines.push(...block(row, { text: TOOL, color: context.expanded ? "gray" : "green" }, [[{ text: summary, dim: context.expanded }]], context.width, true));
  shown.forEach((call, index) => lines.push(...callLines(row, call, context, context.expanded, summary.length === 0 && index === 0)));
  return lines;
};

/** All the tokens a run spent, and its dollars when the provider said. */
const spend = (usage: readonly ModelUsage[] | null): { readonly input: number; readonly output: number; readonly dollars: number | null } => {
  let input = 0;
  let output = 0;
  let dollars: number | null = null;
  for (const model of usage ?? []) {
    input += model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens;
    output += model.outputTokens;
    if (model.costUsd !== null) dollars = (dollars ?? 0) + model.costUsd;
  }
  return { input, output, dollars };
};

/** The cost line's facts for a finished run: its time, its tokens in and out, its dollars. */
export const turnFacts = (run: RunSummary): string[] => {
  const { input, output, dollars } = spend(run.usage);
  return [
    ...(run.durationMs !== null ? [formatDuration(run.durationMs)] : []),
    ...(run.usage !== null ? [`${formatTokens(input)} in`, `${formatTokens(output)} out`] : []),
    ...(dollars !== null ? [formatUsd(dollars)] : []),
  ];
};

/** How a run ended, in words, when it did not simply complete. */
export const endWords = (run: RunSummary): string => {
  if (run.reason === "interrupted") return run.cause === "read-now" ? "Interrupted to read the queue" : "Interrupted";
  return (run.reason ?? "ended").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
};

/** The cost line under a finished turn; a turn that did not complete says how it ended, in amber, or red for an error. */
const turnLines = (row: string, run: RunSummary, context: LineContext): Line[] => {
  const facts = [...turnFacts(run), ...(context.planDeltas?.(run.runId) ?? [])];
  if (run.reason === "completed") return [{ row, spans: [{ text: `${INDENT}${facts.join(" · ")}`, dim: true }] }];
  const color = run.reason === "error" ? "red" : "yellow";
  const body: Span[][] = [[{ text: endWords(run), color }, ...(facts.length > 0 ? [{ text: ` · ${facts.join(" · ")}`, dim: true }] : [])]];
  if (run.error !== null) body.push([{ text: oneLine(run.error.message, 300), color: "red" }]);
  return block(row, { text: "✗", color }, body, context.width, false);
};

/** A prompt where it was asked: what it asked and how it was answered; a plan with its text; a parked one waiting, in amber. */
const promptLines = (row: string, entry: Extract<Row, { kind: "prompt" }>["entry"], context: LineContext): Line[] => {
  const { prompt, answer } = entry;
  const waiting: Span = { text: " — waiting for an answer", color: "yellow" };
  if (entry.kind === "question") {
    const body: Span[][] = [];
    for (const question of prompt.questions ?? []) {
      const given = answer?.answers?.[question.question];
      body.push([{ text: question.question, bold: true }, ...(answer === null ? [waiting] : [{ text: ` — ${given ?? (answer.decision === "deny" ? "skipped" : "answered")}`, dim: true }])]);
    }
    if (body.length === 0) body.push([{ text: prompt.summary, bold: true }, ...(answer === null ? [waiting] : [])]);
    return block(row, { text: "?", color: "cyan" }, body, context.width, true);
  }
  if (entry.kind === "plan") {
    const verdict: Span =
      answer === null
        ? waiting
        : { text: answer.decision === "allow" ? ` — approved${answer.mode ? `, continuing in ${answer.mode.effective}` : ""}` : " — kept planning", dim: true };
    const text = (prompt.plan ?? "").split("\n");
    const shown = context.expanded ? text : text.slice(0, PLAN_LINES);
    const body: Span[][] = [[{ text: "Plan", bold: true }, verdict], ...shown.map((line) => [{ text: line }])];
    if (shown.length < text.length) body.push([{ text: `… +${text.length - shown.length} lines · Ctrl+O`, dim: true }]);
    return block(row, { text: "▤", color: "cyan" }, body, context.width, true);
  }
  const verdict: Span =
    answer === null
      ? waiting
      : {
          text: ` — ${answer.decision === "allow" ? "allowed" : "denied"}${answer.remember === "session" ? " for this session" : ""}${answer.message ? `: ${oneLine(answer.message, 120)}` : ""}`,
          dim: true,
        };
  return block(row, { text: "⚿", dim: answer !== null, ...(answer === null && { color: "yellow" }) }, [[{ text: prompt.summary, dim: answer !== null }, verdict]], context.width, true);
};

/** How many user messages a rewind's fold holds, a fold inside it included. */
const messagesIn = (rows: readonly Row[]): number =>
  rows.reduce((count, row) => count + (row.kind === "user" ? 1 : row.kind === "rewound" ? messagesIn(row.rows) : 0), 0);

/**
 * What a rewind cut: one line saying what the session went back to and how
 * much went with it, with the keys that read it (unfolded, not in the pager,
 * which unfolds everything) and undo it, the undo only on the latest
 * rewind's fold while no run has started since, dim with its reason when it
 * cannot be used now; unfolded, the cut rows under it, marked in the gutter.
 */
const rewoundLines = (row: Extract<Row, { kind: "rewound" }>, context: LineContext): Line[] => {
  const cut = messagesIn(row.rows);
  const head: Span[] = [
    { text: "Rewound: ", bold: true },
    { text: oneLine(row.entry.text, 160) },
    { text: ` · ${cut} ${cut === 1 ? "prompt" : "prompts"} cut`, dim: true },
  ];
  const latest = context.rewound;
  if (!context.expanded) head.push({ text: ` · ${context.unfoldKey ?? "Enter"} unfolds`, dim: true });
  if (latest !== undefined && undoableFold(row, latest)) {
    const { availability } = latest;
    head.push({ text: ` · ${latest.key} undo${availability.status === "absent" ? ` (${availability.message})` : ""}`, dim: true });
  }
  const lines = block(row.id, { text: "↶", color: "yellow" }, [head], context.width, true);
  if (!context.expanded) return lines;
  const inner = transcriptLines(row.rows, { ...context, width: context.width - 2 });
  return [...lines, ...inner.map((line): Line => ({ row: row.id, spans: [{ text: "┊ ", color: "yellow" }, ...line.spans.map((span) => ({ ...span, dim: true }))] }))];
};

/** The lines of one row. */
export const rowLines = (row: Row, context: LineContext): Line[] => {
  const { width } = context;
  switch (row.kind) {
    case "user": {
      const chips = row.entry.attachments.map((a): Span[] => [{ text: `[${a.kind} ${a.name} · ${Math.max(1, Math.round(a.size / 1024))} KB]`, dim: true }]);
      return block(row.id, { text: "▌", color: "cyan" }, [...paragraphs(row.entry.text, { bold: true }), ...chips], width, true);
    }
    case "assistant": {
      const { entry } = row;
      const thinking = entry.kind === "assistant-thinking";
      const body = paragraphs(entry.text, thinking ? { dim: true, italic: true } : {});
      if (entry.aborted) body.push([{ text: "(cut short)", dim: true }]);
      return block(row.id, thinking ? { text: "∴", dim: true } : { text: SPEECH }, body, width, true);
    }
    case "calls":
      return callsLines(row.id, row.calls, context);
    case "command": {
      const { entry } = row;
      const head: Span[] = [{ text: `${entry.name}${entry.args.length > 0 ? ` ${entry.args}` : ""}`, dim: true }];
      return block(row.id, { text: "/", dim: true }, [head, ...returned(cutLines(nonBlank(entry.output ?? ""), context.expanded))], width, true);
    }
    case "prompt":
      return promptLines(row.id, row.entry, context);
    case "subagent": {
      const { entry } = row;
      const who = entry.task?.subagentType ?? "Agent";
      const what = entry.task?.description ?? "";
      const calls = `${entry.calls.length} call${entry.calls.length === 1 ? "" : "s"}`;
      const head: Span[] = [{ text: who, bold: true }, ...(what.length > 0 ? [{ text: `: ${oneLine(what, 120)}` }] : []), { text: ` · ${calls} · ${entry.running ? "running" : "done"}`, dim: true }];
      const body: Span[][] = [head];
      if (context.expanded) for (const call of entry.calls) body.push(...callLines(row.id, call, { ...context, width: width - 2 }, true, false).map((line) => [...line.spans]));
      return block(row.id, { text: "⤷", color: entry.running ? "cyan" : "gray" }, body, width, true);
    }
    case "turn":
      return turnLines(row.id, row.run, context);
    case "opaque":
      return [{ row: row.id, spans: [{ text: `${INDENT}· ${row.entry.type}: an event this version does not show`, dim: true }] }];
    case "rewound":
      return rewoundLines(row, context);
  }
};

/** Every line of `rows`, in order. */
export const transcriptLines = (rows: readonly Row[], context: LineContext, unfolded: ReadonlySet<string> = new Set()): Line[] =>
  rows.flatMap((row) => rowLines(row, unfolded.has(row.id) ? { ...context, expanded: true } : context));

/** A line's text, as plain characters: what a test, `/copy` and the pager's search read. */
export const lineText = (line: Line): string => line.spans.map((span) => span.text).join("");
