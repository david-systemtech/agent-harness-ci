import {
  attachmentChip,
  fileUndoWords,
  classifyTool,
  clockTime,
  endWords,
  environmentMessage,
  formatDuration,
  oneLine,
  outputText,
  summarizeToolInput,
  transcriptRows,
  turnFacts,
  updateInterruptedText,
  type ForkedFrom,
  type SessionProjection,
  type ToolCallEntry,
  type TranscriptEntry,
  type TranscriptRow as Row,
} from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";

/**
 * The transcript as text for `/export`, `/copy` and `/timeline`
 * (docs/specs/tui.md, "The transcript"; over `projections.session`): the same
 * rows the screen draws, read whole, so the file, the clipboard and the
 * ledger never say something the transcript does not. Pure.
 */

/** A call as one line: its title, or its name with a gloss of its input. */
const callHead = (call: ToolCallEntry): string => {
  if (call.title !== null && call.title.length > 0) return call.title;
  const gloss = summarizeToolInput(call.input);
  return gloss.length > 0 ? `${call.name}(${gloss})` : call.name;
};

const callState = (call: ToolCallEntry): string => (call.decision?.decision === "denied" ? "denied" : call.status);

/** One row as markdown; a fork's first row names what `forked` says of its source. */
const rowMarkdown = (row: Row, forked?: ForkedFrom): string => {
  switch (row.kind) {
    case "user": {
      const attached = row.entry.attachments.map((a) => `_attached ${a.kind} ${attachmentChip(a)}_`);
      return [`### ${environmentMessage(row.entry) ? "Environment" : "You"} · ${clockTime(row.entry.sentAt)}`, row.entry.text, ...attached].join("\n\n");
    }
    case "assistant":
      return row.entry.kind === "assistant-thinking" ? row.entry.text.split("\n").map((line) => `> ${line}`).join("\n") : row.entry.text;
    case "calls":
      return row.calls
        .map((call) => {
          const output = outputText(call.output).trimEnd();
          const time = call.durationMs !== null && call.durationMs >= 1000 ? ` (${formatDuration(call.durationMs)})` : "";
          const head = `- \`${oneLine(callHead(call), 200)}\` — ${callState(call)}${time}`;
          return output.length > 0 && call.status !== "ok" ? `${head}\n\n  \`\`\`\n${output.split("\n").map((l) => `  ${l}`).join("\n")}\n  \`\`\`` : head;
        })
        .join("\n");
    case "command":
      return [`\`/${row.entry.name}${row.entry.args.length > 0 ? ` ${row.entry.args}` : ""}\``, row.entry.output ?? ""].filter((part) => part.length > 0).join("\n\n");
    case "prompt": {
      const { prompt, answer } = row.entry;
      const verdict = answer === null ? "waiting for an answer" : answer.decision === "allow" ? "allowed" : "denied";
      if (row.entry.kind === "plan") return [`**Plan** — ${verdict}`, prompt.plan ?? ""].filter((part) => part.length > 0).join("\n\n");
      return `**${row.entry.kind === "question" ? "Asked" : "Permission"}:** ${prompt.summary} — ${verdict}`;
    }
    case "subagent":
      return `- ${row.entry.task?.subagentType ?? "Agent"}: ${row.entry.task?.description ?? ""} (${row.entry.calls.length} calls)`;
    case "turn":
      return `_${[...(row.run.reason === "completed" ? [] : [endWords(row.run)]), ...turnFacts(row.run)].join(" · ")}_`;
    case "file-undo":
      return `_${fileUndoWords(row.entry)} ${row.entry.changeId}_`;
    case "opaque":
      return `_${row.entry.type}: an event this version does not show_`;
    case "rewound": {
      // What a rewind cut is kept, quoted under a line saying so, as the screen keeps it under its fold.
      const cut = row.rows.map((inner) => rowMarkdown(inner, forked)).filter((text) => text.length > 0).join("\n\n");
      const quoted = cut.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n");
      // A cut with nothing to show is the line alone: an empty text split is one empty line, which would quote as a bare `>`.
      return [`_Rewound to ${oneLine(row.entry.text, 200)}: what the rewind cut follows._`, ...(cut.length > 0 ? [quoted] : [])].join("\n\n");
    }
    case "forked":
      return `_Forked from ${forked?.title ?? "another session"}${forked?.anchor != null ? ` at ${oneLine(forked.anchor, 200)}` : ""}._`;
    case "update-interrupted":
      return `_${updateInterruptedText(row.entry)}_`;
    case "history-unreadable":
      return `_The history could not be read: ${oneLine(row.entry.message, 300)}_`;
  }
};

/** The session as a markdown document: its title, then every row; a fork's first row names what `forked` says of its source. */
export const exportMarkdown = (
  view: Pick<SessionProjection, "items" | "runs" | "summary">,
  header: { readonly environment: string; readonly at: Date; readonly forked?: ForkedFrom },
): string => {
  const title = view.summary?.title ?? "Session";
  const rows = transcriptRows(view)
    .map((row) => rowMarkdown(row, header.forked))
    .filter((text) => text.length > 0);
  return `# ${title}\n\n_Exported from ${header.environment} at ${header.at.toISOString()}_\n\n${rows.join("\n\n")}\n`;
};

/** The fenced code blocks of a markdown text, in order, without their fences. */
export const codeBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  let open: { readonly rail: string; readonly lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open === null) {
      if (fence) open = { rail: fence[1] ?? "```", lines: [] };
    } else if (fence && (fence[1] ?? "").startsWith(open.rail)) {
      blocks.push(open.lines.join("\n"));
      open = null;
    } else open.lines.push(line);
  }
  return blocks;
};

/** One turn of `/timeline`: a run, what it was asked, and what it did. */
export interface Turn {
  readonly runId: string;
  readonly at: string;
  readonly asked: string;
  readonly run: RunSummary;
  readonly files: readonly string[];
  readonly commands: number;
  /** Some of this run's transcript is held under a rewind fold. */
  readonly cut: boolean;
}

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"];

/** The runs of the session, oldest first, each with the prompt it read, the files it edited and the commands it ran. */
export const turnsOf = (view: Pick<SessionProjection, "items" | "runs">): Turn[] => {
  const entries: TranscriptEntry[] = [];
  const cutRuns = new Set<string>();
  const collect = (items: readonly TranscriptEntry[], cut: boolean): void => {
    for (const entry of items) {
      if (entry.kind === "rewound") collect(entry.items, true);
      else {
        entries.push(entry);
        if (cut && "runId" in entry && entry.runId !== null) cutRuns.add(entry.runId);
      }
    }
  };
  collect(view.items, false);
  const messages = new Map(entries.flatMap((entry) => (entry.kind === "user-message" ? [[entry.messageId, entry.text] as const] : [])));
  const calls = entries.flatMap((entry) => (entry.kind === "tool-call" ? [entry] : entry.kind === "subagent" ? entry.calls : []));
  return view.runs.map((run) => {
    const ids = [...(run.promptMessageId !== null ? [run.promptMessageId] : []), ...run.queuedMessageIds];
    const asked = ids.map((id) => messages.get(id) ?? "").filter((text) => text.length > 0).join(" / ");
    const own = calls.filter((call) => call.runId === run.runId);
    const files: string[] = [];
    for (const call of own) {
      if (call.status !== "ok" || classifyTool(call.name) !== "edit") continue;
      const path = PATH_KEYS.map((key) => call.input[key]).find((value): value is string => typeof value === "string" && value.length > 0);
      if (path !== undefined && !files.includes(path)) files.push(path);
    }
    return { runId: run.runId, at: run.startedAt, asked, run, files, commands: own.filter((call) => classifyTool(call.name) === "command").length, cut: cutRuns.has(run.runId) };
  });
};

/** A turn as one line: when, what was asked, how long and what it cost, what it touched, how it ended. */
export const timelineLine = (turn: Turn): string => {
  const { run } = turn;
  const outcome = run.state === "running" ? "running" : run.reason === "completed" ? "" : endWords(run).toLowerCase();
  const touched = [
    ...(turn.files.length > 0 ? [`${turn.files.length} file${turn.files.length === 1 ? "" : "s"}`] : []),
    ...(turn.commands > 0 ? [`${turn.commands} command${turn.commands === 1 ? "" : "s"}`] : []),
  ];
  const facts = [...turnFacts(run), ...touched, ...(outcome.length > 0 ? [outcome] : []), ...(turn.cut ? ["cut"] : [])];
  return `${clockTime(turn.at)}  ${oneLine(turn.asked.length > 0 ? turn.asked : "(no prompt)", 60)}${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
};
