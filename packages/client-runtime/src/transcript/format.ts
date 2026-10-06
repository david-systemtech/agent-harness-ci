import type { ModelUsage, RunSummary } from "@agent-harness/contracts";

/** A turn's time and a time where the client is, as every client says them (#1742). */
export { clockTime, whenWords } from "@agent-harness/contracts";

/**
 * What a tool call was, in words, and the numbers a transcript prints
 * (docs/specs/tui.md, "Testing Decisions": the fold's pure helpers), in the
 * terminal and in the window alike. A run's finished calls fold into one
 * sentence ("Ran 36 commands, read 6 files"), and this is where a tool name
 * becomes one of its clauses; a finished turn's cost line says its time,
 * tokens and dollars, and how it ended when it did not complete.
 *
 * A closed set of categories, because tool names are provider vocabulary:
 * Claude says `Bash` and `Edit`, Codex says `shell` and `apply_patch`, and an
 * MCP server says what it likes. A name nothing lists lands in `other` and
 * reads as "used a tool", which is true and unembarrassing.
 */

export type ToolCategory = "command" | "read" | "edit" | "search" | "web" | "agent" | "plan" | "mcp" | "other";

/** Clauses in this order, most consequential first: something that changed the machine outranks something that looked at it. */
export const TOOL_CATEGORIES: readonly ToolCategory[] = ["command", "edit", "read", "search", "web", "agent", "plan", "mcp", "other"];

/** Counts per category; an absent key is zero. */
export type ActivityCounts = Readonly<Partial<Record<ToolCategory, number>>>;

/** Tool name to category, keyed by the name with case and separators folded away. Claude's vocabulary and Codex's. */
const BY_NAME: Readonly<Record<string, ToolCategory>> = {
  bash: "command",
  bashoutput: "command",
  killshell: "command",
  killbash: "command",
  shell: "command",
  localshell: "command",
  run: "command",
  runcommand: "command",
  read: "read",
  readfile: "read",
  notebookread: "read",
  viewimage: "read",
  write: "edit",
  writefile: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  applypatch: "edit",
  strreplace: "edit",
  glob: "search",
  grep: "search",
  ls: "search",
  listdir: "search",
  find: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  task: "agent",
  agent: "agent",
  dispatchagent: "agent",
  todowrite: "plan",
  updateplan: "plan",
  exitplanmode: "plan",
  taskcreate: "plan",
  taskupdate: "plan",
};

const normalize = (name: string): string => name.toLowerCase().replace(/[_\-\s.]/g, "");

/** One call's category. An MCP tool (`mcp__<server>__<tool>`) is `mcp` whatever its own name, so a server's `read` is no file read. */
export const classifyTool = (name: string): ToolCategory => (name.startsWith("mcp__") ? "mcp" : (BY_NAME[normalize(name)] ?? "other"));

/** How each category says itself, finished and in flight, `{n}` the count; lowercase, the sentence capitalises its first clause. */
const PHRASES: Readonly<Record<ToolCategory, { readonly one: string; readonly many: string; readonly oneLive: string; readonly manyLive: string }>> = {
  command: { one: "ran a command", many: "ran {n} commands", oneLive: "running a command", manyLive: "running {n} commands" },
  edit: { one: "edited a file", many: "edited {n} files", oneLive: "editing a file", manyLive: "editing {n} files" },
  read: { one: "read a file", many: "read {n} files", oneLive: "reading a file", manyLive: "reading {n} files" },
  search: { one: "searched the code", many: "searched the code {n} times", oneLive: "searching the code", manyLive: "searching the code" },
  web: { one: "fetched a page", many: "fetched {n} pages", oneLive: "fetching a page", manyLive: "fetching {n} pages" },
  agent: { one: "delegated to an agent", many: "delegated to {n} agents", oneLive: "delegating to an agent", manyLive: "delegating to {n} agents" },
  plan: { one: "updated the plan", many: "updated the plan {n} times", oneLive: "updating the plan", manyLive: "updating the plan" },
  mcp: { one: "called an MCP tool", many: "called {n} MCP tools", oneLive: "calling an MCP tool", manyLive: "calling {n} MCP tools" },
  other: { one: "used a tool", many: "used {n} tools", oneLive: "using a tool", manyLive: "using {n} tools" },
};

const clause = (category: ToolCategory, n: number, live: boolean): string => {
  const phrase = PHRASES[category];
  if (n === 1) return live ? phrase.oneLive : phrase.one;
  return (live ? phrase.manyLive : phrase.many).replace("{n}", String(n));
};

/** The fold's sentence for `counts`, present tense throughout when `live`; empty for no calls. */
export const describeActivity = (counts: ActivityCounts, live = false): string => {
  const parts: string[] = [];
  for (const category of TOOL_CATEGORIES) {
    const n = counts[category] ?? 0;
    if (n > 0) parts.push(clause(category, n, live));
  }
  if (parts.length === 0) return "";
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** `1234` is `1.2k`: token counts get large and a line does not. */
export const formatTokens = (n: number): string => {
  if (Number.isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};

/** Dollars, with enough precision that a sub-cent run does not read `$0.00`. */
export const formatUsd = (v: number): string => {
  if (Number.isNaN(v)) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
};

/** A duration in the smallest unit that still reads clearly; rounded to whole seconds first past ten, so it never says 60 seconds. */
export const formatDuration = (ms: number): string => {
  if (Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/**
 * An attachment sent with a message, as its chip says it in every client:
 * its name and its size in whole KB, never less than 1 (`screen.png · 1 KB`).
 * `message.sent` logs an `AttachmentRecord` and never the bytes, so a sent
 * picture is named, not drawn (David, #473; serving the bytes is #1016).
 */
export const attachmentChip = (attachment: { readonly name: string; readonly size: number }): string =>
  `${attachment.name} · ${String(Math.max(1, Math.round(attachment.size / 1024)))} KB`;

/** Whitespace collapsed and the text clipped to `max`, for one-line summaries. */
export const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The argument names a one-line gloss of a call looks for first, across every agent CLI. */
const GLOSS_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "prompt", "description", "notebook_path"];

/** A one-line gloss of a tool's input: a well-known argument, else the first short string, else its keys. */
export const summarizeToolInput = (input: Readonly<Record<string, unknown>> | null | undefined): string => {
  if (!input) return "";
  for (const key of GLOSS_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value, 96);
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length <= 96) return oneLine(value, 96);
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }` : "";
};

/** A tool's output as text: a string as it is, anything else as JSON; empty for none. */
export const outputText = (output: unknown): string => {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2) ?? "";
  } catch {
    return String(output);
  }
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
  if (run.reason === "interrupted") return run.cause === "read-now" ? "Interrupted to read the queue" : run.cause === "timeout" ? "Interrupted at the routine's time limit" : "Interrupted";
  return (run.reason ?? "ended").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
};
